#!/usr/bin/env node
/**
 * 拾光轴 · Timeline Board —— 多用户看板 API server（v15）
 *
 * 零 native 依赖：node:http 原生 + node:sqlite（DatabaseSync，Node 24 内置）
 * + node:crypto（scrypt 密码哈希 / HMAC token）。Node 直接运行，不经 vite/tsc。
 *
 * 数据模型：单表 boards（board_id 随机 16 位 hex / name / doc JSON 文本 /
 * version 整数 / password_hash / created_at / updated_at）。
 * doc = { items, orders, products, members, meta:{ name, created_at } } ——
 * 前端四份状态原样打包，结构零重构。
 *
 * 接口：
 *   GET    /api/health                  → { ok: true }
 *   GET    /api/boards                  → 列表（id/name/updated_at/卡片数/version，不含 doc/密码）
 *   POST   /api/boards                  { name, password, doc? } → { board_id }（建板无门槛）
 *   POST   /api/boards/:id/auth         { password } → { token, expires_at }；连续 5 次失败锁 60s（429）
 *   GET    /api/boards/:id?version=N    （Bearer token）version 相同 → { changed:false }，否则 → { changed:true, doc, version }
 *   PUT    /api/boards/:id              （Bearer token）{ doc } 整板覆盖，version+1（LWW，无冲突检测）
 *   DELETE /api/boards/:id              { password } 必须重新输密码（不认 token），物理删除不可恢复
 *
 * v18 item 级端点（第三方 agent 读写；同一套 Bearer token，无独立 agent key）：
 *   GET   /api/boards/:id/items?date=&product_id=&member=&status=&q=  卡片列表（过滤可叠加，按 publish_at 排序）
 *   GET   /api/boards/:id/items/:itemId                               单张卡片（404 处理）
 *   PATCH /api/boards/:id/items/:itemId  白名单字段补丁（校验复用 import-core 规则；逐字段审计）
 *   GET   /api/boards/:id/products       产品目录
 *   GET   /api/boards/:id/members        成员目录
 *   GET   /api/boards/:id/audit?limit=50 PATCH 审计（倒序，limit ≤200）
 *   限速：以上端点每 board 每 IP 120 次/分钟（BOARD_AGENT_RPM 可调），超限 429 { error, retry_after }
 *
 * 环境变量：API_PORT（默认 8787）/ BOARD_DB（默认 packages/server/boards.sqlite）/
 *   BOARD_SECRET（token 签名密钥；缺省生成随机并警告，重启后 token 全失效）/
 *   BOARD_TOKEN_HOURS（默认 12）/ BOARD_LOCK_SECONDS（默认 60）/ BOARD_AGENT_RPM（默认 120）
 */
import http from 'node:http'
import crypto from 'node:crypto'
import path from 'node:path'
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
// v18+：PATCH 校验复用 @timeline/core 的枚举与归一化规则（Node 24 strip-types 经
// workspaces 软链直引包内 .ts——realpath 不在 node_modules 内，类型擦除生效，零构建）
import { TYPES, STATUSES, normalizePublishAt } from '@timeline/core/import-core'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PORT = Number(process.env.API_PORT || 8787)
// 默认库文件落在 server 包目录内（packages/server/boards.sqlite）；生产用 BOARD_DB 指向数据目录
const DB_PATH = process.env.BOARD_DB || path.join(path.dirname(fileURLToPath(import.meta.url)), 'boards.sqlite')
const TOKEN_TTL_MS = Number(process.env.BOARD_TOKEN_HOURS || 12) * 3600_000
const LOCK_MS = Number(process.env.BOARD_LOCK_SECONDS || 60) * 1000
const MAX_FAILS = 5
const MAX_BODY = 8 * 1024 * 1024 // 单板几百卡片，8MB 绰绰有余
// v18：item 级端点限速（每 board 每 IP 每分钟；内存滑动窗口，与 auth 限速同风格）
const AGENT_RPM = Number(process.env.BOARD_AGENT_RPM || 120)

let SECRET = process.env.BOARD_SECRET
if (!SECRET) {
  SECRET = crypto.randomBytes(32).toString('hex')
  console.warn(
    '[boards] ⚠ 未设置 BOARD_SECRET，已生成随机 secret（server 重启后所有 token 失效，需重新输密码）；生产环境请设置 BOARD_SECRET',
  )
}

// ---------------------------------------------------------------------------
// SQLite（单表；WAL 提升并发读体验）
// ---------------------------------------------------------------------------
mkdirSync(path.dirname(DB_PATH), { recursive: true })
const db = new DatabaseSync(DB_PATH)
db.exec(`
  CREATE TABLE IF NOT EXISTS boards (
    board_id      TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    doc           TEXT NOT NULL,
    version       INTEGER NOT NULL DEFAULT 1,
    password_hash TEXT NOT NULL,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
  )
`)
// v18：PATCH 逐字段审计（旧值→新值，非字符串值 JSON 序列化）
db.exec(`
  CREATE TABLE IF NOT EXISTS audit_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    ts         TEXT NOT NULL,
    board_id   TEXT NOT NULL,
    item_id    TEXT NOT NULL,
    field      TEXT NOT NULL,
    old_value  TEXT,
    new_value  TEXT
  )
`)
db.exec('PRAGMA journal_mode = WAL')

const qList = db.prepare('SELECT board_id, name, version, doc, updated_at FROM boards ORDER BY updated_at DESC')
const qGet = db.prepare('SELECT * FROM boards WHERE board_id = ?')
const qInsert = db.prepare(
  'INSERT INTO boards (board_id, name, doc, version, password_hash, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?, ?)',
)
const qUpdate = db.prepare('UPDATE boards SET doc = ?, version = version + 1, updated_at = ? WHERE board_id = ?')
const qDelete = db.prepare('DELETE FROM boards WHERE board_id = ?')
const qAuditInsert = db.prepare(
  'INSERT INTO audit_log (ts, board_id, item_id, field, old_value, new_value) VALUES (?, ?, ?, ?, ?, ?)',
)
const qAuditList = db.prepare('SELECT * FROM audit_log WHERE board_id = ? ORDER BY id DESC LIMIT ?')

// ---------------------------------------------------------------------------
// 密码哈希（scrypt:<saltHex>:<hashHex>）与 token（base64url(payload).base64url(hmac)）
// ---------------------------------------------------------------------------
function hashPassword(password) {
  const salt = crypto.randomBytes(16)
  const hash = crypto.scryptSync(password, salt, 32)
  return `scrypt:${salt.toString('hex')}:${hash.toString('hex')}`
}
function verifyPassword(password, stored) {
  const parts = String(stored).split(':')
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false
  const salt = Buffer.from(parts[1], 'hex')
  const expect = Buffer.from(parts[2], 'hex')
  const actual = crypto.scryptSync(password, salt, expect.length)
  return crypto.timingSafeEqual(actual, expect)
}

function signToken(boardId) {
  const exp = Date.now() + TOKEN_TTL_MS
  const payload = Buffer.from(JSON.stringify({ bid: boardId, exp })).toString('base64url')
  const sig = crypto.createHmac('sha256', SECRET).update(payload).digest('base64url')
  return { token: `${payload}.${sig}`, exp }
}
function verifyToken(header, boardId) {
  const m = /^Bearer (.+)$/.exec(String(header ?? ''))
  if (!m) return false
  const [payload, sig] = m[1].split('.')
  if (!payload || !sig) return false
  const expect = crypto.createHmac('sha256', SECRET).update(payload).digest('base64url')
  const a = Buffer.from(sig)
  const b = Buffer.from(expect)
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString())
    return data.bid === boardId && typeof data.exp === 'number' && data.exp > Date.now()
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// 登录限速：同板连续 5 次失败锁 60s（内存态，重启清零——可接受的弱化）
// ---------------------------------------------------------------------------
const authFails = new Map() // boardId -> { fails, lockedUntil }
function authLocked(boardId) {
  const rec = authFails.get(boardId)
  if (!rec) return 0
  if (rec.lockedUntil && rec.lockedUntil > Date.now()) return Math.ceil((rec.lockedUntil - Date.now()) / 1000)
  return 0
}
function noteAuthFail(boardId) {
  const rec = authFails.get(boardId) ?? { fails: 0, lockedUntil: 0 }
  rec.fails++
  if (rec.fails >= MAX_FAILS) {
    rec.fails = 0
    rec.lockedUntil = Date.now() + LOCK_MS
  }
  authFails.set(boardId, rec)
}
function noteAuthOk(boardId) {
  authFails.delete(boardId)
}

// ---------------------------------------------------------------------------
// v18 item 级端点限速：每 board 每 IP 滑动窗口（默认 120 次/分钟，内存态）
// ---------------------------------------------------------------------------
const agentHits = new Map() // `${boardId}|${ip}` -> number[]（时间戳升序）
function agentRateLimited(boardId, ip) {
  const now = Date.now()
  const key = `${boardId}|${ip}`
  const hits = (agentHits.get(key) ?? []).filter((t) => t > now - 60_000)
  if (hits.length >= AGENT_RPM) {
    agentHits.set(key, hits)
    return Math.max(1, Math.ceil((hits[0] + 60_000 - now) / 1000))
  }
  hits.push(now)
  agentHits.set(key, hits)
  return 0
}

// ---------------------------------------------------------------------------
// v18 PATCH 校验：白名单字段 + import-core 同口径规则与同风格中文文案
// ---------------------------------------------------------------------------
const PATCH_FIELDS = [
  'title',
  'type',
  'status',
  'publish_at',
  'product_id',
  'content_owner_id',
  'delivery_owner_id',
  'roi',
  'propagation_4h',
  'engagement_4h',
  'comment',
]

/** 空 → null；非负数字 → number；其余报错（与 import-core normalizeMetric 同口径同文案） */
function normalizeMetricPatch(raw, name) {
  if (raw === null || raw === undefined || String(raw).trim() === '') return { value: null }
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) return { value: null, error: `${name} 须为空或非负数字，得到 "${raw}"` }
  return { value: n }
}

/** 成员自动 id：扫描目录 id 数字后缀取 max+1（与 MemberManagerDialog.nextMemberId 一致） */
function nextMemberId(members) {
  let max = 1000
  for (const m of members) {
    const match = String(m.id).match(/(\d+)$/)
    if (match) max = Math.max(max, Number(match[1]))
  }
  return `M-${String(max + 1).padStart(4, '0')}`
}

/**
 * 负责人值解析（mergeMembers 语义）：空 → ''（未分配）；命中既有 id → 原样；
 * 命中既有姓名 → 复用其 id；未知姓名 → 自动登记进目录（追加到 pendingMembers）
 */
function resolveOwnerPatch(raw, members, pendingMembers) {
  const v = String(raw ?? '').trim()
  if (!v) return ''
  const byId = [...members, ...pendingMembers].find((m) => m.id === v)
  if (byId) return byId.id
  const byName = [...members, ...pendingMembers].find((m) => m.name === v)
  if (byName) return byName.id
  const id = nextMemberId([...members, ...pendingMembers])
  pendingMembers.push({ id, name: v })
  return id
}

/** 目标日列内下一个 order（与 board-view.nextOrder 同语义：末尾 order+1，空列 0） */
function nextOrderPatch(items, orders, date) {
  const col = items
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => c.publish_at.slice(0, 10) === date)
    .sort((a, b) => (orders[a.c.id] ?? 0) - (orders[b.c.id] ?? 0) || a.i - b.i)
  return col.length ? (orders[col[col.length - 1].c.id] ?? 0) + 1 : 0
}

/** 审计值序列化：字符串原样，其余（null/number）JSON 序列化 */
const auditVal = (v) => (typeof v === 'string' ? v : JSON.stringify(v))

// ---------------------------------------------------------------------------
// HTTP 辅助
// ---------------------------------------------------------------------------
function send(res, status, body, headers = {}) {
  const text = body === undefined ? '' : JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers })
  res.end(text)
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > MAX_BODY) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      if (!chunks.length) return resolve({})
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString()))
      } catch {
        reject(new Error('invalid json'))
      }
    })
    req.on('error', reject)
  })
}

const newBoardId = () => crypto.randomBytes(8).toString('hex') // 16 位 hex

// v16：单板卡片容量硬上限（软提示 1500 在前端 TopBar）
const MAX_CARDS = 2000
const MAX_CARDS_MSG = `已达单板上限 ${MAX_CARDS} 张，请按时间切片新建看板`

/** doc 结构最低校验（整板覆盖写入前的兜底，前端四份状态原样打包） */
function validDoc(doc) {
  return (
    !!doc &&
    typeof doc === 'object' &&
    Array.isArray(doc.items) &&
    !!doc.orders &&
    typeof doc.orders === 'object' &&
    !Array.isArray(doc.orders) &&
    Array.isArray(doc.products) &&
    Array.isArray(doc.members)
  )
}

const emptyDoc = (name) => ({
  items: [],
  orders: {},
  products: [],
  members: [],
  meta: { name, created_at: new Date().toISOString() },
})

// ---------------------------------------------------------------------------
// 路由
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x')
    const p = url.pathname

    if (p === '/api/health' && req.method === 'GET') return send(res, 200, { ok: true })

    // GET /api/boards —— 列表（不含 doc 与密码）
    if (p === '/api/boards' && req.method === 'GET') {
      const boards = qList.all().map((r) => {
        let cards = 0
        try {
          const d = JSON.parse(r.doc)
          if (Array.isArray(d.items)) cards = d.items.length
        } catch {
          // 损坏行按 0 计
        }
        return { board_id: r.board_id, name: r.name, version: r.version, cards, updated_at: r.updated_at }
      })
      return send(res, 200, { boards })
    }

    // POST /api/boards —— 创建（建板无门槛；doc 缺省为空板，前端负责种子/初始化）
    if (p === '/api/boards' && req.method === 'POST') {
      const body = await readBody(req)
      const name = String(body.name ?? '').trim()
      const password = String(body.password ?? '')
      if (!name) return send(res, 400, { error: 'name 必填且非空' })
      if (!password) return send(res, 400, { error: 'password 必填且非空' })
      const doc = body.doc === undefined ? emptyDoc(name) : body.doc
      if (!validDoc(doc)) return send(res, 400, { error: 'doc 结构非法：需要 { items[], orders{}, products[], members[] }' })
      if (doc.items.length > MAX_CARDS) return send(res, 400, { error: MAX_CARDS_MSG }) // v16 硬上限
      if (!doc.meta || typeof doc.meta !== 'object') doc.meta = { name, created_at: new Date().toISOString() }
      const id = newBoardId()
      const now = new Date().toISOString()
      qInsert.run(id, name, JSON.stringify(doc), hashPassword(password), now, now)
      return send(res, 201, { board_id: id })
    }

    const m = /^\/api\/boards\/([0-9a-f]{16})(\/auth)?$/.exec(p)
    if (m) {
      const id = m[1]
      const isAuth = m[2] === '/auth'
      const row = qGet.get(id)

      // POST /api/boards/:id/auth —— 密码换 token（限速：5 次失败锁 60s）
      if (isAuth && req.method === 'POST') {
        if (!row) return send(res, 404, { error: '看板不存在' })
        const locked = authLocked(id)
        if (locked > 0) return send(res, 429, { error: `失败次数过多，请 ${locked} 秒后重试`, retry_after: locked })
        const body = await readBody(req)
        if (!verifyPassword(String(body.password ?? ''), row.password_hash)) {
          noteAuthFail(id)
          const left = authLocked(id)
          return left > 0
            ? send(res, 429, { error: `失败次数过多，请 ${left} 秒后重试`, retry_after: left })
            : send(res, 403, { error: '密码错误' })
        }
        noteAuthOk(id)
        const { token, exp } = signToken(id)
        return send(res, 200, { token, expires_at: new Date(exp).toISOString() })
      }

      if (isAuth) return send(res, 405, { error: 'method not allowed' })
      if (!row) return send(res, 404, { error: '看板不存在' })

      // GET /api/boards/:id?version=N —— 带 token 拉取（version 相同 → changed:false）
      if (req.method === 'GET') {
        if (!verifyToken(req.headers.authorization, id)) return send(res, 401, { error: 'token 缺失或已过期' })
        const v = url.searchParams.get('version')
        if (v !== null && Number(v) === row.version) {
          return send(res, 200, { changed: false, version: row.version })
        }
        return send(res, 200, { changed: true, doc: JSON.parse(row.doc), version: row.version })
      }

      // PUT /api/boards/:id —— 带 token 整板覆盖（LWW，version+1）
      if (req.method === 'PUT') {
        if (!verifyToken(req.headers.authorization, id)) return send(res, 401, { error: 'token 缺失或已过期' })
        const body = await readBody(req)
        if (!validDoc(body.doc)) return send(res, 400, { error: 'doc 结构非法：需要 { items[], orders{}, products[], members[] }' })
        if (body.doc.items.length > MAX_CARDS) return send(res, 400, { error: MAX_CARDS_MSG }) // v16 硬上限
        qUpdate.run(JSON.stringify(body.doc), new Date().toISOString(), id)
        return send(res, 200, { version: qGet.get(id).version })
      }

      // DELETE /api/boards/:id —— 必须重新输密码（不认 token），物理删除
      if (req.method === 'DELETE') {
        const body = await readBody(req)
        if (!verifyPassword(String(body.password ?? ''), row.password_hash)) {
          return send(res, 403, { error: '密码错误' })
        }
        qDelete.run(id)
        authFails.delete(id)
        return send(res, 204, undefined)
      }

      return send(res, 405, { error: 'method not allowed' })
    }

    // ------------------------------------------------------------------
    // v18 item 级端点：/items(/:itemId) /products /members /audit
    // 鉴权与既有端点同一套 Bearer token；顺序：404 板 → 401 token → 429 限速
    // ------------------------------------------------------------------
    const m2 = /^\/api\/boards\/([0-9a-f]{16})\/(items|products|members|audit)(?:\/([^/]+))?$/.exec(p)
    if (m2) {
      const id = m2[1]
      const scope = m2[2]
      const itemId = m2[3] ? decodeURIComponent(m2[3]) : null
      const row = qGet.get(id)
      if (!row) return send(res, 404, { error: '看板不存在' })
      if (!verifyToken(req.headers.authorization, id)) return send(res, 401, { error: 'token 缺失或已过期' })
      const retry = agentRateLimited(id, req.socket.remoteAddress ?? '?')
      if (retry > 0) return send(res, 429, { error: `请求过于频繁，请 ${retry} 秒后重试`, retry_after: retry })
      const doc = JSON.parse(row.doc)

      // GET /api/boards/:id/products —— 产品目录数组
      if (scope === 'products' && req.method === 'GET') return send(res, 200, { products: doc.products })

      // GET /api/boards/:id/members —— 成员目录数组
      if (scope === 'members' && req.method === 'GET') return send(res, 200, { members: doc.members })

      // GET /api/boards/:id/audit?limit=50 —— PATCH 审计（倒序，上限 200）
      if (scope === 'audit' && req.method === 'GET') {
        let limit = Number(url.searchParams.get('limit') ?? 50)
        if (!Number.isInteger(limit) || limit < 1) limit = 50
        limit = Math.min(limit, 200)
        return send(res, 200, { entries: qAuditList.all(id, limit) })
      }

      // GET /api/boards/:id/items?date=&product_id=&member=&status=&q= —— 过滤可叠加，按 publish_at 排序
      if (scope === 'items' && !itemId && req.method === 'GET') {
        let out = [...doc.items]
        const date = url.searchParams.get('date')
        if (date) out = out.filter((it) => it.publish_at.slice(0, 10) === date)
        const pid = url.searchParams.get('product_id')
        if (pid !== null) out = out.filter((it) => it.product_id === pid)
        const member = url.searchParams.get('member')
        if (member) {
          const hit = doc.members.find((x) => x.id === member || x.name === member)
          out = hit ? out.filter((it) => it.content_owner_id === hit.id || it.delivery_owner_id === hit.id) : []
        }
        const status = url.searchParams.get('status')
        if (status) out = out.filter((it) => it.status === status)
        const q = url.searchParams.get('q')
        if (q) {
          const needle = q.toLowerCase()
          out = out.filter(
            (it) => it.title.toLowerCase().includes(needle) || String(it.comment ?? '').toLowerCase().includes(needle),
          )
        }
        out.sort((a, b) => a.publish_at.localeCompare(b.publish_at))
        return send(res, 200, { items: out })
      }

      // GET /api/boards/:id/items/:itemId —— 单张卡片
      if (scope === 'items' && itemId && req.method === 'GET') {
        const item = doc.items.find((it) => it.id === itemId)
        if (!item) return send(res, 404, { error: '卡片不存在' })
        return send(res, 200, { item })
      }

      // PATCH /api/boards/:id/items/:itemId —— 白名单字段补丁（读出 doc、改单条、写回，不整板覆盖）
      if (scope === 'items' && itemId && req.method === 'PATCH') {
        const body = await readBody(req)
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
          return send(res, 400, { error: '请求体须为字段补丁对象' })
        }
        const item = doc.items.find((it) => it.id === itemId)
        if (!item) return send(res, 404, { error: '卡片不存在' })
        const bad = Object.keys(body).filter((k) => !PATCH_FIELDS.includes(k))
        if (bad.length) return send(res, 400, { error: `不支持修改的字段: ${bad.join(', ')}` })

        // 逐字段校验归一化（import-core 同口径规则与文案）
        const errors = []
        const next = { ...item }
        const pendingMembers = [] // 本次 PATCH 自动登记的新成员（mergeMembers 语义）
        if ('title' in body) {
          const v = String(body.title ?? '').trim()
          if (!v) errors.push('title 必填且非空')
          else next.title = v
        }
        if ('type' in body) {
          const v = String(body.type ?? '').trim()
          if (!TYPES.includes(v)) errors.push(`type 非法: "${v}"，合法值: ${TYPES.join(' / ')}`)
          else next.type = v
        }
        if ('status' in body) {
          const v = String(body.status ?? '').trim()
          if (!STATUSES.includes(v)) errors.push(`status 非法: "${v}"，合法值: ${STATUSES.join(' / ')}`)
          else next.status = v
        }
        if ('publish_at' in body) {
          const v = normalizePublishAt(body.publish_at)
          if (!v) {
            errors.push(
              `publish_at 无法解析: "${body.publish_at}"（接受 YYYY-MM-DDTHH:mm / YYYY-MM-DD HH:mm / YYYY/M/D H:mm）`,
            )
          } else next.publish_at = v
        }
        // 未知 product_id 保留原样、不动目录（PATCH 不携带 product_name，不触发登记）
        if ('product_id' in body) next.product_id = String(body.product_id ?? '').trim()
        if ('content_owner_id' in body) next.content_owner_id = resolveOwnerPatch(body.content_owner_id, doc.members, pendingMembers)
        if ('delivery_owner_id' in body) next.delivery_owner_id = resolveOwnerPatch(body.delivery_owner_id, doc.members, pendingMembers)
        for (const f of ['roi', 'propagation_4h', 'engagement_4h']) {
          if (f in body) {
            const r = normalizeMetricPatch(body[f], f)
            if (r.error) errors.push(r.error)
            else next[f] = r.value
          }
        }
        if ('comment' in body) next.comment = String(body.comment ?? '')
        if (errors.length) return send(res, 400, { error: errors.join('；') })

        // 与 UI updateCard 同口径：最终状态非「已发布」→ 三指标强制 null
        if (next.status !== '已发布') {
          next.roi = null
          next.propagation_4h = null
          next.engagement_4h = null
        }

        // 按实际变化字段审计；无变化 → 200 但不写审计、version 不增
        const changes = PATCH_FIELDS.filter((f) => next[f] !== item[f]).map((f) => ({
          field: f,
          old_value: item[f],
          new_value: next[f],
        }))
        if (!changes.length && !pendingMembers.length) {
          return send(res, 200, { changed: false, version: row.version, item })
        }

        // orders 联动（与 UI updateCard 一致）：publish_at 跨日 → 排到目标日列末尾；同日时分变更不动
        const oldDate = item.publish_at.slice(0, 10)
        const newDate = next.publish_at.slice(0, 10)
        if (newDate !== oldDate) doc.orders[itemId] = nextOrderPatch(doc.items, doc.orders, newDate)

        doc.items = doc.items.map((it) => (it.id === itemId ? next : it))
        if (pendingMembers.length) doc.members = [...doc.members, ...pendingMembers]
        const now = new Date().toISOString()
        qUpdate.run(JSON.stringify(doc), now, id) // 与 PUT 同一持久化路径（version+1、updated_at 刷新）
        for (const c of changes) qAuditInsert.run(now, id, itemId, c.field, auditVal(c.old_value), auditVal(c.new_value))
        return send(res, 200, { changed: true, version: qGet.get(id).version, item: next })
      }

      return send(res, 405, { error: 'method not allowed' })
    }

    return send(res, 404, { error: 'not found' })
  } catch (e) {
    if (String(e?.message).includes('invalid json')) return send(res, 400, { error: '请求体不是合法 JSON' })
    if (String(e?.message).includes('body too large')) return send(res, 413, { error: '请求体过大' })
    console.error('[boards] 未捕获错误:', e)
    return send(res, 500, { error: 'internal error' })
  }
})

server.listen(PORT, () => {
  console.log(`[boards] API server listening on http://127.0.0.1:${PORT}（db: ${path.relative(ROOT, DB_PATH)}）`)
})
