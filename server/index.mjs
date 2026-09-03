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
 * 环境变量：API_PORT（默认 8787）/ BOARD_DB（默认 server/boards.sqlite）/
 *   BOARD_SECRET（token 签名密钥；缺省生成随机并警告，重启后 token 全失效）/
 *   BOARD_TOKEN_HOURS（默认 12）/ BOARD_LOCK_SECONDS（默认 60）
 */
import http from 'node:http'
import crypto from 'node:crypto'
import path from 'node:path'
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PORT = Number(process.env.API_PORT || 8787)
const DB_PATH = process.env.BOARD_DB || path.join(ROOT, 'server', 'boards.sqlite')
const TOKEN_TTL_MS = Number(process.env.BOARD_TOKEN_HOURS || 12) * 3600_000
const LOCK_MS = Number(process.env.BOARD_LOCK_SECONDS || 60) * 1000
const MAX_FAILS = 5
const MAX_BODY = 8 * 1024 * 1024 // 单板几百卡片，8MB 绰绰有余

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
db.exec('PRAGMA journal_mode = WAL')

const qList = db.prepare('SELECT board_id, name, version, doc, updated_at FROM boards ORDER BY updated_at DESC')
const qGet = db.prepare('SELECT * FROM boards WHERE board_id = ?')
const qInsert = db.prepare(
  'INSERT INTO boards (board_id, name, doc, version, password_hash, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?, ?)',
)
const qUpdate = db.prepare('UPDATE boards SET doc = ?, version = version + 1, updated_at = ? WHERE board_id = ?')
const qDelete = db.prepare('DELETE FROM boards WHERE board_id = ?')

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
