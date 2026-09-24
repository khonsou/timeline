#!/usr/bin/env node
/**
 * 视觉升级 A 期截图验收（一次性脚本，非 e2e 回归）：
 *   mock Auth（:5281，进程内）+ 真实 API（:5282，tmp sqlite 用完即删）+ vite（:5283），
 *   无头 Chrome 1440×900 @2x，亮/暗双主题各截：
 *     登录门 AuthGate / 首页看板列表 / 看板主界面 / 卡片详情弹窗（含评论区滚动到底各一张）
 *   暗色经 localStorage `timeline-theme` 预置（useTheme 存储键）。
 * 产物：/Users/linan/Documents/Kimi/Workspaces/Timeline/shots-visual-a/*.png
 * 端口纪律：5281/5282/5283 本脚本独占（被占直接退出）；跑完杀进程组 + 删 tmp sqlite + 确认端口释放。
 */
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import puppeteer from 'puppeteer-core'
import { startMockOauth } from './mock-oauth.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const OUT = '/Users/linan/Documents/Kimi/Workspaces/Timeline/shots-visual-a'
const MOCK_PORT = 5281
const API_PORT = 5282
const WEB_PORT = 5283
const WEB = `http://localhost:${WEB_PORT}`
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const TMP = mkdtempSync(path.join(tmpdir(), 'shots-visual-a-'))
const BOARD_NAME = '视觉升级 A 期验收板'
const BOARD_PASS = 'visual-a-pass'

mkdirSync(OUT, { recursive: true })

const pad = (n) => String(n).padStart(2, '0')
const dayKey = (offset, hhmm) => {
  const d = new Date()
  d.setDate(d.getDate() + offset)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${hhmm}`
}

// 覆盖：已发布带指标（互动率渐变）/ 待发布 / 待执行 / 双负责人 / 备注；今天列 2 张（橙色 accent）。
// type 用合法枚举（图文/视频/音频/直播/数据）；负责人引用下方 MEMBERS_FIXTURE 的 id。
const ITEMS = [
  { id: 'va-0001', title: '视觉验收 · 图文稿', type: '图文', publish_at: dayKey(-2, '09:00'), status: '已发布', roi: 3.3, propagation_4h: 1280, engagement_4h: 342, content_owner_id: 'M-9001', delivery_owner_id: 'M-9002', comment: '已发布带指标，验证互动率渐变与 KPI 配色' },
  { id: 'va-0002', title: '视觉验收 · 短视频', type: '视频', publish_at: dayKey(-1, '10:30'), status: '待执行', content_owner_id: 'M-9002', delivery_owner_id: '', comment: '' },
  { id: 'va-0003', title: '视觉验收 · 音频节目', type: '音频', publish_at: dayKey(0, '08:00'), status: '已发布', roi: 1.8, propagation_4h: 860, engagement_4h: 210, content_owner_id: 'M-9001', delivery_owner_id: 'M-9001', comment: '今天列已发布卡' },
  { id: 'va-0004', title: '视觉验收 · 直播预告', type: '直播', publish_at: dayKey(0, '20:00'), status: '待发布', content_owner_id: 'M-9003', delivery_owner_id: '', comment: '今天列待发布卡（指标恒空）' },
  { id: 'va-0005', title: '视觉验收 · 数据周报', type: '数据', publish_at: dayKey(1, '09:30'), status: '待执行', content_owner_id: '', delivery_owner_id: 'M-9002', comment: '备注文字可读性检查' },
  { id: 'va-0006', title: '视觉验收 · 复盘图文', type: '图文', publish_at: dayKey(2, '14:00'), status: '待发布', content_owner_id: 'M-9001', delivery_owner_id: '', comment: '' },
  { id: 'va-0007', title: '视觉验收 · 花絮视频', type: '视频', publish_at: dayKey(3, '11:00'), status: '待执行', content_owner_id: 'M-9003', delivery_owner_id: 'M-9002', comment: '' },
]
const MEMBERS_FIXTURE = [
  { id: 'M-9001', name: '林晓' },
  { id: 'M-9002', name: '陈远' },
  { id: 'M-9003', name: '赵六' },
]

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function api(method, p, body, token) {
  const res = await fetch(`http://localhost:${API_PORT}/api${p}`, {
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
  } catch {}
  return { status: res.status, body: json }
}
const children = []
function start(name, args, cwd, env) {
  const child = spawn(process.execPath, args, {
    cwd,
    env: { ...process.env, ...env },
    detached: true, // 独立进程组，收尾按组 SIGKILL
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stderr.on('data', (d) => process.stderr.write(`[${name}] ${d}`))
  children.push(child)
  return child
}
function killAll() {
  for (const c of children) {
    try {
      process.kill(-c.pid, 'SIGKILL')
    } catch {}
  }
}
process.on('exit', killAll)

async function portBusy(port) {
  try {
    await fetch(`http://localhost:${port}/`, { signal: AbortSignal.timeout(800) })
    return true
  } catch {
    return false
  }
}
async function waitReady(url, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const r = await fetch(url)
      if (r.ok) return
    } catch {}
    if (Date.now() > deadline) throw new Error(`等待就绪超时: ${url}`)
    await sleep(300)
  }
}

const checks = []
const check = (name, ok, extra = '') => {
  checks.push([name, ok])
  console.log(`${ok ? '✓' : '✗'} ${name}${extra ? ` —— ${extra}` : ''}`)
}

let browser
let mockServer = null
try {
  for (const p of [MOCK_PORT, API_PORT, WEB_PORT]) {
    if (await portBusy(p)) throw new Error(`端口 ${p} 被占用，请先释放再跑`)
  }
  mockServer = await startMockOauth(MOCK_PORT)
  start('api', [path.join(ROOT, 'packages/server/index.mjs')], ROOT, {
    API_PORT: String(API_PORT),
    BOARD_DB: path.join(TMP, 'boards.sqlite'),
    BOARD_SECRET: 'shots-visual-a-secret',
  })
  start('vite', [path.join(ROOT, 'node_modules/vite/bin/vite.js'), '--port', String(WEB_PORT), '--strictPort'], path.join(ROOT, 'web'), {
    API_PORT: String(API_PORT),
    VITE_AUTH_ORIGIN: `http://127.0.0.1:${MOCK_PORT}`,
  })
  await waitReady(`http://localhost:${API_PORT}/api/health`)
  await waitReady(`${WEB}/`)
  console.log(`[shots] mock Auth :${MOCK_PORT} + API :${API_PORT} + vite :${WEB_PORT} 已就绪`)

  browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--disable-gpu', '--hide-scrollbars', '--force-color-profile=srgb'],
    defaultViewport: { width: 1440, height: 900, deviceScaleFactor: 2 },
  })
  const page = await browser.newPage()
  const pageErrors = []
  page.on('pageerror', (e) => pageErrors.push(String(e)))

  const shot = (name) => page.screenshot({ path: path.join(OUT, name) })
  const isDark = () => page.evaluate(() => document.documentElement.classList.contains('dark'))
  const backToToday = () =>
    page.evaluate(() => {
      ;[...document.querySelectorAll('button')].find((b) => b.textContent.includes('回到今天'))?.click()
    })
  const openCard = (title) =>
    page.evaluate((t) => {
      const el = [...document.querySelectorAll('[data-card-title]')].find((n) => n.textContent === t)
      el?.closest('.group')?.click()
      return !!el
    }, title)
  const addComment = (text) =>
    page.evaluate((t) => {
      const el = document.querySelector('[data-comments-input]')
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
      setter.call(el, t)
      el.dispatchEvent(new Event('input', { bubbles: true }))
      document.querySelector('[data-comments-send]')?.click()
    }, text)
  const scrollDetail = (top) =>
    page.evaluate((v) => {
      const el = document.querySelector('[data-detail-scroll]')
      if (el) el.scrollTop = v === 'bottom' ? el.scrollHeight : 0
    }, top)

  // ================= 亮主题 =================
  // 1) 登录门（亮）
  await page.goto(`${WEB}/`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => !!document.querySelector('[data-oauth-login]'), { timeout: 15000 })
  await sleep(500)
  await shot('01-gate-light.png')
  check('01 登录门（亮）', !(await isDark()))

  // 2) mock 登录 → 首页
  await page.evaluate(() => document.querySelector('[data-oauth-login]')?.click())
  await page.waitForFunction(() => !!document.querySelector('[data-home]') && !document.querySelector('[data-auth-gate]'), {
    timeout: 20000,
  })
  await sleep(500)

  // 3) 创建看板（创建即持证进板）
  await page.type('[data-create-name]', BOARD_NAME)
  await page.type('[data-create-password]', BOARD_PASS)
  await page.click('[data-create-btn]')
  await page.waitForSelector('[data-theme-toggle]', { timeout: 15000 })
  await sleep(600)
  const boardUrl = page.url()

  // 4) 注入验收卡片：UI 导入不给 group_id（卡片全落「未分组」），改走 API 整板 PUT：
  //    首载迁移已把日期组建好（groups[] 为 {id, name:'YYYY-MM-DD'}），按 publish_at 日期部分挂组、orders 全局递增。
  //    PUT 仅需 Bearer token（无 If-Match 走兼容模式）；页面 5s 轮询自动套用新快照，无需 reload（reload 会丢纯内存 OAuth 会话）。
  const boardId = /\/b\/([0-9a-f]{16})/.exec(boardUrl)?.[1]
  const authRes = await api('POST', `/boards/${boardId}/auth`, { password: BOARD_PASS })
  if (authRes.status !== 200 || !authRes.body?.token) {
    throw new Error(`看板 auth 失败: ${authRes.status} ${JSON.stringify(authRes.body)}`)
  }
  const token = authRes.body.token
  const cur = await api('GET', `/boards/${boardId}`, undefined, token)
  if (cur.status !== 200 || !cur.body?.doc) throw new Error(`读取看板 doc 失败: ${cur.status} ${JSON.stringify(cur.body)}`)
  const doc = cur.body.doc
  const groupIdByName = new Map((doc.groups ?? []).map((g) => [g.name, g.id]))
  const items = ITEMS.map((it) => {
    const published = it.status === '已发布'
    return {
      id: it.id,
      title: it.title,
      type: it.type,
      publish_at: it.publish_at,
      status: it.status,
      roi: published ? it.roi : null,
      comment: it.comment ?? '',
      product_id: '',
      content_owner_id: it.content_owner_id ?? '',
      delivery_owner_id: it.delivery_owner_id ?? '',
      propagation_4h: published ? it.propagation_4h : null,
      engagement_4h: published ? it.engagement_4h : null,
      group_id: groupIdByName.get(it.publish_at.slice(0, 10)) ?? null,
    }
  })
  const orders = Object.fromEntries(items.map((it, i) => [it.id, i]))
  const put = await api(
    'PUT',
    `/boards/${boardId}`,
    { doc: { ...doc, items, orders, members: [...(doc.members ?? []), ...MEMBERS_FIXTURE] } },
    token,
  )
  check('API 整板注入 7 张验收卡', put.status === 200, `PUT=${put.status} groups=${doc.groups?.length ?? 0}`)
  await page.waitForFunction(
    () => document.querySelectorAll('[data-card-title]').length === 7 && /共\s*7\s*张卡片/.test(document.body.innerText),
    { timeout: 20000 },
  )
  await sleep(600)
  const colDist = await page.evaluate(() =>
    [...document.querySelectorAll('[data-group-column]')].map((c) => ({
      key: c.getAttribute('data-group-key') || c.getAttribute('data-group-column'),
      n: c.querySelectorAll('[data-card-title]').length,
    })),
  )
  console.log(`[shots] 列分布: ${JSON.stringify(colDist)}`)

  // 5) 看板主界面（亮）：TopBar / 今天列 / 卡片 / minimap
  await backToToday()
  await sleep(800)
  await shot('03-board-light.png')
  check('03 看板主界面（亮）', true)

  // 6) 详情弹窗（亮）：已发布带指标卡 + 补一条评论
  check('打开详情弹窗（亮）', await openCard('视觉验收 · 图文稿'))
  await page.waitForFunction(() => !!document.querySelector('[data-comments-input]'), { timeout: 8000 })
  await sleep(400)
  addComment('陈远：首评，验证评论区亮色可读性')
  await page.waitForFunction(() => document.querySelectorAll('[data-comments-item]').length === 1, { timeout: 6000 })
  await scrollDetail(0)
  await sleep(400)
  await shot('04-detail-light.png')
  await scrollDetail('bottom')
  await sleep(400)
  await shot('05-detail-comments-light.png')
  check('04/05 详情弹窗 + 评论区（亮）', true)
  // 评论框聚焦时 Esc 只 blur 不关弹窗：连按两次（先 blur 后关窗），确保回到看板
  await page.keyboard.press('Escape')
  await sleep(300)
  await page.keyboard.press('Escape')
  await sleep(400)

  // 7) 首页（亮）：看板列表 + 创建看板 industrial 按钮
  // 注意：OAuth 会话纯内存（auth.ts），整页 reload 会掉回登录门——返回首页走 SPA（TopBar ← 列表）
  await page.evaluate(() => document.querySelector('[data-back-home]')?.click())
  await page.waitForSelector('[data-home]', { timeout: 15000 })
  await sleep(1000) // 等 listBoards 回包渲染
  const homeState = await page.evaluate(() => ({
    table: !!document.querySelector('[data-board-table]'),
    rows: document.querySelectorAll('[data-board-row]').length,
    err: document.querySelector('[data-list-error]')?.textContent ?? null,
    gate: !!document.querySelector('[data-auth-gate]'),
  }))
  check('02 首页看板列表（亮）', homeState.table && homeState.rows === 1, JSON.stringify(homeState))
  await shot('02-home-light.png')

  // ================= 暗主题 =================
  // localStorage 预置暗色 + reload：会话随之内存失效，正好先拍暗色登录门再重新登录
  await page.evaluate(() => localStorage.setItem('timeline-theme', 'dark'))
  await page.reload({ waitUntil: 'networkidle0' })
  await page.waitForFunction(() => !!document.querySelector('[data-oauth-login]'), { timeout: 15000 })
  await sleep(500)
  check('暗色预置生效', (await isDark()) && (await page.evaluate(() => localStorage.getItem('timeline-theme'))) === 'dark')
  await shot('06-gate-dark.png')
  check('06 登录门（暗）', await isDark())

  // 9) 重新登录 → 首页（暗）
  await page.evaluate(() => document.querySelector('[data-oauth-login]')?.click())
  await page.waitForFunction(() => !!document.querySelector('[data-home]') && !document.querySelector('[data-auth-gate]'), {
    timeout: 20000,
  })
  await sleep(800)
  await shot('07-home-dark.png')
  check('07 首页看板列表（暗）', true)

  // 10) 看板主界面（暗）：SPA 点列表行进板（板级 token 在 sessionStorage，大概率免密码门；兜底输密码）
  await page.evaluate(() => document.querySelector('[data-board-open]')?.click())
  await sleep(1000)
  if (await page.$('[data-gate-password]')) {
    await page.type('[data-gate-password]', BOARD_PASS)
    await page.click('[data-gate-submit]')
  }
  await page.waitForSelector('[data-theme-toggle]', { timeout: 15000 })
  await sleep(600)

  // 10) 看板主界面（暗）
  await backToToday()
  await sleep(800)
  await shot('08-board-dark.png')
  check('08 看板主界面（暗）', await isDark())

  // 11) 详情弹窗（暗）
  check('打开详情弹窗（暗）', await openCard('视觉验收 · 图文稿'))
  await page.waitForFunction(() => !!document.querySelector('[data-comments-input]'), { timeout: 8000 })
  await sleep(400)
  await scrollDetail(0)
  await sleep(300)
  await shot('09-detail-dark.png')
  await scrollDetail('bottom')
  await sleep(300)
  await shot('10-detail-comments-dark.png')
  check('09/10 详情弹窗 + 评论区（暗）', true)

  check('无页面运行时错误', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '))
} catch (e) {
  check(`流程异常: ${e instanceof Error ? e.message : String(e)}`, false)
} finally {
  if (browser) await browser.close().catch(() => {})
  killAll()
  if (mockServer) {
    try {
      await new Promise((resolve) => mockServer.close(resolve))
    } catch {}
  }
  await sleep(500)
  rmSync(TMP, { recursive: true, force: true })
}

// 端口释放确认
let portsFree = true
for (const p of [MOCK_PORT, API_PORT, WEB_PORT]) {
  try {
    await fetch(`http://localhost:${p}/`)
    portsFree = false
  } catch {}
}
check('5281/5282/5283 进程组杀净、端口释放', portsFree)

const failed = checks.filter(([, ok]) => !ok)
console.log(`\n[shots-visual-a] ${checks.length - failed.length} PASS / ${failed.length} FAIL → ${OUT}`)
process.exit(failed.length ? 1 : 0)
