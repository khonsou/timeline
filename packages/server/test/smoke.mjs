#!/usr/bin/env node
/**
 * @timeline/server 冒烟（node 脚本，无浏览器）：起子进程 server（端口 5197 +
 * 临时 sqlite + BOARD_AGENT_RPM=3 便于构造 429），跑通 v18 Agent API 主链路：
 * 建板 → 密码换 token → items 过滤 → 单卡 → PATCH（校验/指标联动/负责人登记/
 * orders 联动）→ audit → 无变化幂等 → 限速 429 → 删板。跑完杀进程组、删临时库。
 *
 * 端口纪律：仅用 5197；不碰 5198/5199（e2e）与 7100/7101/7102/8787。
 */
import { spawn } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PORT = 5197
const API = `http://localhost:${PORT}/api`
const DB = path.join(os.tmpdir(), `timeline-server-smoke-${process.pid}.sqlite`)
const SERVER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'index.mjs')

let passed = 0
let failed = 0
const ok = (cond, name, detail = '') => {
  if (cond) {
    passed++
    console.log(`  ✓ ${name}`)
  } else {
    failed++
    console.error(`  ✗ ${name} ${detail}`)
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function api(method, p, body, token) {
  const res = await fetch(`${API}${p}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  let json = null
  try {
    json = await res.json()
  } catch {
    // 204
  }
  return { status: res.status, body: json }
}

let proc = null
try {
  for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) rmSync(f, { force: true })
  proc = spawn(process.execPath, [SERVER], {
    detached: true,
    env: {
      ...process.env,
      API_PORT: String(PORT),
      BOARD_DB: DB,
      BOARD_SECRET: 'smoke-secret',
      BOARD_AGENT_RPM: '1000', // 主链路不限速；429 单独用低上限实例测
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(`${API}/health`, { signal: AbortSignal.timeout(500) })
      if (r.ok) break
    } catch {}
    if (i > 40) throw new Error('server 启动超时')
    await sleep(250)
  }

  // 建板（3 卡：昨天已发布带指标 / 今天待发布 / 明天待执行）
  const pad = (n) => String(n).padStart(2, '0')
  const fmt = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  const day = (n) => fmt(new Date(Date.now() + n * 86400000))
  const doc = {
    items: [
      { id: 's-01', title: '昨日卡', type: '图文', publish_at: `${day(-1)}T09:00`, roi: 2.5, comment: '', product_id: 'P-1000', status: '已发布', content_owner_id: '', delivery_owner_id: '', propagation_4h: 12000, engagement_4h: 800 },
      { id: 's-02', title: '今日卡', type: '视频', publish_at: `${day(0)}T10:00`, roi: null, comment: '', product_id: 'P-1000', status: '待发布', content_owner_id: 'M-1001', delivery_owner_id: '', propagation_4h: null, engagement_4h: null },
      { id: 's-03', title: '明日卡', type: '数据', publish_at: `${day(1)}T11:00`, roi: null, comment: '', product_id: '', status: '待执行', content_owner_id: '', delivery_owner_id: '', propagation_4h: null, engagement_4h: null },
    ],
    orders: { 's-01': 0, 's-02': 0, 's-03': 0 },
    products: [{ id: 'P-1000', name: '光轴' }],
    members: [{ id: 'M-1001', name: '林晓' }],
    meta: { name: 'smoke', created_at: new Date().toISOString() },
  }
  const mk = await api('POST', '/boards', { name: 'smoke 板', password: 'pw', doc })
  ok(mk.status === 201, '建板 201')
  const bid = mk.body.board_id

  const noTok = await api('GET', `/boards/${bid}/items`)
  ok(noTok.status === 401, '无 token 401')
  const auth = await api('POST', `/boards/${bid}/auth`, { password: 'pw' })
  ok(auth.status === 200 && auth.body.token, '密码换 token')
  const tk = auth.body.token

  const list = await api('GET', `/boards/${bid}/items`, undefined, tk)
  ok(list.status === 200 && list.body.items.length === 3, 'items 列表 3 张')
  const filt = await api('GET', `/boards/${bid}/items?date=${day(0)}&status=${encodeURIComponent('待发布')}`, undefined, tk)
  ok(filt.body.items.length === 1 && filt.body.items[0].id === 's-02', 'date+status 叠加过滤')
  const byMember = await api('GET', `/boards/${bid}/items?member=${encodeURIComponent('林晓')}`, undefined, tk)
  ok(byMember.body.items.length === 1 && byMember.body.items[0].id === 's-02', 'member=姓名过滤')
  const byQ = await api('GET', `/boards/${bid}/items?q=${encodeURIComponent('明日')}`, undefined, tk)
  ok(byQ.body.items.length === 1 && byQ.body.items[0].id === 's-03', 'q 关键词过滤')
  const sorted = list.body.items.every((it, i, a) => i === 0 || a[i - 1].publish_at <= it.publish_at)
  ok(sorted, '按 publish_at 升序')

  const one = await api('GET', `/boards/${bid}/items/s-02`, undefined, tk)
  ok(one.status === 200 && one.body.item.title === '今日卡', '单卡 GET')
  const miss = await api('GET', `/boards/${bid}/items/nope`, undefined, tk)
  ok(miss.status === 404, '单卡 404')

  // PATCH：标题 + 指标联动（待发布写 roi 强制 null；置已发布后指标可写）
  const p1 = await api('PATCH', `/boards/${bid}/items/s-02`, { title: '今日卡·改', roi: 9.9 }, tk)
  ok(p1.body.changed === true && p1.body.item.title === '今日卡·改' && p1.body.item.roi === null, 'PATCH 改标题；待发布 roi 强制 null')
  const p2 = await api('PATCH', `/boards/${bid}/items/s-02`, { status: '已发布', roi: 3.3 }, tk)
  ok(p2.body.item.status === '已发布' && p2.body.item.roi === 3.3, '已发布可写指标')
  const pBad = await api('PATCH', `/boards/${bid}/items/s-02`, { id: 'x' }, tk)
  ok(pBad.status === 400 && /不支持修改的字段: id/.test(pBad.body.error), '白名单外字段 400')
  const pEnum = await api('PATCH', `/boards/${bid}/items/s-02`, { status: '进行中' }, tk)
  ok(pEnum.status === 400 && /status 非法/.test(pEnum.body.error), '非法枚举 400')
  const pOwner = await api('PATCH', `/boards/${bid}/items/s-02`, { content_owner_id: '赵六' }, tk)
  ok(pOwner.body.item.content_owner_id === 'M-1002', '未知负责人姓名自动登记 M-1002')
  const mems = await api('GET', `/boards/${bid}/members`, undefined, tk)
  ok(mems.body.members.some((m) => m.name === '赵六'), 'members 端点可见新成员')
  const prods = await api('GET', `/boards/${bid}/products`, undefined, tk)
  ok(prods.body.products.length === 1 && prods.body.products[0].id === 'P-1000', 'products 端点')

  // orders 联动：s-03 改期到昨天（列内已有 s-01 order 0 → s-03 应为 1）
  const pDate = await api('PATCH', `/boards/${bid}/items/s-03`, { publish_at: `${day(-1)} 12:00` }, tk)
  ok(pDate.body.item.publish_at === `${day(-1)}T12:00`, 'publish_at 归一化')
  const full = await api('GET', `/boards/${bid}`, undefined, tk)
  ok(full.body.doc.orders['s-03'] === 1 && full.body.doc.orders['s-01'] === 0, '跨日 orders 排目标日列尾')

  // 审计：逐字段旧→新（倒序，最新是 publish_at）
  const audit = await api('GET', `/boards/${bid}/audit?limit=50`, undefined, tk)
  const f = audit.body.entries
  ok(f.length >= 5 && f[0].field === 'publish_at' && f[0].item_id === 's-03', 'audit 逐字段倒序', JSON.stringify(f?.[0]))
  ok(f.some((e) => e.field === 'roi' && e.old_value === 'null' && e.new_value === '3.3'), 'audit 指标旧→新（JSON 序列化）')

  // 无变化 PATCH：200 但不写审计、version 不增
  const v1 = full.body.version
  const a1 = audit.body.entries[0].id
  const pSame = await api('PATCH', `/boards/${bid}/items/s-02`, { title: '今日卡·改', roi: 3.3 }, tk)
  const full2 = await api('GET', `/boards/${bid}`, undefined, tk)
  const audit2 = await api('GET', `/boards/${bid}/audit?limit=1`, undefined, tk)
  ok(pSame.body.changed === false && full2.body.version === v1 && audit2.body.entries[0].id === a1, '无变化 PATCH 幂等（不写审计不增 version）')

  const del = await api('DELETE', `/boards/${bid}`, { password: 'pw' })
  ok(del.status === 204, '删板 204')

  // 既有整板路径回归：PUT version+1 / ?version=N changed:false
  const mk2 = await api('POST', '/boards', { name: '回归', password: 'pw' })
  const bid2 = mk2.body.board_id
  const tk2 = (await api('POST', `/boards/${bid2}/auth`, { password: 'pw' })).body.token
  const put = await api('PUT', `/boards/${bid2}`, { doc }, tk2)
  const same = await api('GET', `/boards/${bid2}?version=${put.body.version}`, undefined, tk2)
  ok(put.status === 200 && same.body.changed === false, 'PUT/version 轮询语义不变')
  await api('DELETE', `/boards/${bid2}`, { password: 'pw' })
} catch (e) {
  failed++
  console.error('  ✗ 冒烟主流程异常：', e)
} finally {
  if (proc && !proc.killed) {
    try {
      process.kill(-proc.pid, 'SIGKILL')
    } catch {
      try { proc.kill('SIGKILL') } catch {}
    }
  }
  await sleep(200)
  for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) rmSync(f, { force: true })
}

console.log(`\n[server-smoke] ${passed} PASS / ${failed} FAIL`)
process.exit(failed ? 1 : 0)
