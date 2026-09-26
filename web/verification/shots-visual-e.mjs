#!/usr/bin/env node
/**
 * 视觉升级 E 期（看板面校准）截图走查（一次性脚本，非 e2e 回归）：
 * 打已起好的 dev 栈（npm run dev 自带 mock OAuth :5190 --jwt；本脚本不起/杀任何进程），
 * 无头 Chrome 1440×900 @2x，亮/暗双主题各截：看板主界面 / 详情弹窗 / 关系图 / 搜索面板。
 * 数据：复用 dev 库既有「字体 B 期走查板」（不新建板），API 整板 PUT 注入 7 列验收卡
 * （今天 ±3 天覆盖周末列；含已发布带指标/待发布/待执行/前后关系链/评论/背景色/置灰），
 * 页面 5s 轮询自动套用，无需 reload（reload 会丢纯内存 OAuth 会话）。
 * 断言（computed 实锤）：
 *  - 亮：页面底 rgb(240,237,237) < 列底 rgb(232,229,233)（灰紫拉开）、卡白 rgb(255,255,255)；
 *  - 详情信息格/评论项 = --inset-bg（亮 rgb(235,232,235) / 暗 rgb(30,27,35)）；
 *  - 暗：列底仍介于纯黑页底与卡片面之间（变量化暗色值）；
 *  - 关系图边 stroke 走 --graph-edge 变量（亮 rgb(207,203,210) / 暗 rgb(82,76,92)）。
 * 产物：/Users/linan/Documents/Kimi/Workspaces/Timeline/shots-visual-e/*.png
 */
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import puppeteer from 'puppeteer-core'

const API = 'http://127.0.0.1:8787'
const WEB = 'http://localhost:7100' // vite 绑定 localhost（::1）；勿用 127.0.0.1
const OUT = '/Users/linan/Documents/Kimi/Workspaces/Timeline/shots-visual-e'
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const BOARD_NAME = '字体 B 期走查板'
const BOARD_PASS = 'visual-b-pass'

mkdirSync(OUT, { recursive: true })

const pad = (n) => String(n).padStart(2, '0')
const dayKey = (offset, hhmm) => {
  const d = new Date()
  d.setDate(d.getDate() + offset)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${hhmm}`
}
const dayName = (offset) => dayKey(offset, '00:00').slice(0, 10)

// 7 个日期列（今天 ±3，必然覆盖一个周末）；组 id 走查专用前缀，PUT 整板覆盖。
const OFFSETS = [-3, -2, -1, 0, 1, 2, 3]
const GROUPS = OFFSETS.map((o, i) => ({ id: `ge-${i}`, name: dayName(o) }))
const gid = (o) => GROUPS[OFFSETS.indexOf(o)].id

// 覆盖：已发布带指标 / 待发布 / 待执行 / 前后关系链（图视图有边）/ 评论 / 背景色 / 置灰
const NOW = new Date()
const iso = (h) => new Date(NOW.getTime() - h * 3600_000).toISOString()
const ITEMS = [
  { id: 've-0001', title: '校准走查 · 图文稿', type: '图文', publish_at: dayKey(-3, '09:00'), status: '已发布', roi: 3.3, propagation_4h: 1280, engagement_4h: 342, group_id: gid(-3), content_owner_id: 'M-9001', delivery_owner_id: 'M-9002', comment: '三层色差：页面底 < 列底 < 卡白' },
  { id: 've-0002', title: '校准走查 · 短视频', type: '视频', publish_at: dayKey(-2, '10:30'), status: '待执行', group_id: gid(-2), content_owner_id: 'M-9002', delivery_owner_id: '', comment: '', pre_ids: ['ve-0001'] },
  { id: 've-0003', title: '校准走查 · 音频节目', type: '音频', publish_at: dayKey(-1, '08:00'), status: '已发布', roi: 1.8, propagation_4h: 860, engagement_4h: 210, group_id: gid(-1), content_owner_id: 'M-9001', delivery_owner_id: 'M-9001', comment: '', pre_ids: ['ve-0001'] },
  { id: 've-0004', title: '校准走查 · 直播预告', type: '直播', publish_at: dayKey(0, '08:00'), status: '待发布', group_id: gid(0), content_owner_id: 'M-9003', delivery_owner_id: '', comment: '今天列待发布卡', pre_ids: ['ve-0002', 've-0003'] },
  {
    id: 've-0005', title: '校准走查 · 数据周报', type: '数据', publish_at: dayKey(0, '20:00'), status: '已发布', roi: 4.6, propagation_4h: 2380, engagement_4h: 691, group_id: gid(0), content_owner_id: 'M-9001', delivery_owner_id: 'M-9002',
    comment: '今天列已发布卡，带评论与背景色', pre_ids: ['ve-0003'], bg_color: '#f59e0b',
    comments: [
      { id: 'vc-01', author: '林晓', body: '信息格与卡片白之间的层次刚好，不喧宾。', created_at: iso(26) },
      { id: 'vc-02', author: '', body: '匿名评论也要落在 inset 底上。', created_at: iso(2) },
    ],
  },
  { id: 've-0006', title: '校准走查 · 复盘图文', type: '图文', publish_at: dayKey(1, '09:30'), status: '待执行', group_id: gid(1), content_owner_id: '', delivery_owner_id: 'M-9002', comment: '', pre_ids: ['ve-0004'] },
  { id: 've-0007', title: '校准走查 · 花絮视频（置灰）', type: '视频', publish_at: dayKey(2, '14:00'), status: '待发布', group_id: gid(2), content_owner_id: 'M-9001', delivery_owner_id: '', comment: '', dimmed: true },
  { id: 've-0008', title: '校准走查 · 收官直播', type: '直播', publish_at: dayKey(3, '11:00'), status: '待执行', group_id: gid(3), content_owner_id: 'M-9003', delivery_owner_id: 'M-9002', comment: '', pre_ids: ['ve-0005', 've-0006'] },
]
const MEMBERS_FIXTURE = [
  { id: 'M-9001', name: '林晓' },
  { id: 'M-9002', name: '陈远' },
  { id: 'M-9003', name: '赵六' },
]

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function api(method, p, body, token) {
  const res = await fetch(`${API}/api${p}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  let json = null
  try {
    json = await res.json()
  } catch {}
  return { status: res.status, body: json }
}
const checks = []
const check = (name, ok, extra = '') => {
  checks.push([name, ok])
  console.log(`${ok ? '✓' : '✗'} ${name}${extra ? ` —— ${extra}` : ''}`)
}

// 复用 dev 库既有走查板（同名可能多块，取 updated_at 最新的一块），不新建
const list = await api('GET', '/boards')
if (list.status !== 200 || !Array.isArray(list.body?.boards)) throw new Error(`板列表失败: ${list.status}`)
const board = list.body.boards.filter((b) => b.name === BOARD_NAME).sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))[0]
if (!board) throw new Error(`dev 库没有「${BOARD_NAME}」`)
const boardId = board.board_id
console.log(`[shots] 复用「${BOARD_NAME}」 ${boardId}（updated_at=${board.updated_at}，cards=${board.cards}）`)

const authRes = await api('POST', `/boards/${boardId}/auth`, { password: BOARD_PASS })
if (authRes.status !== 200 || !authRes.body?.token) throw new Error(`看板 auth 失败: ${authRes.status}`)
const token = authRes.body.token
const cur = await api('GET', `/boards/${boardId}`, undefined, token)
if (cur.status !== 200 || !cur.body?.doc) throw new Error(`读取看板 doc 失败: ${cur.status}`)
const items = ITEMS.map((it) => ({
  roi: null,
  propagation_4h: null,
  engagement_4h: null,
  comment: '',
  product_id: '',
  content_owner_id: '',
  delivery_owner_id: '',
  ...it,
}))
const orders = Object.fromEntries(items.map((it, i) => [it.id, i]))
const put = await api(
  'PUT',
  `/boards/${boardId}`,
  { doc: { ...cur.body.doc, groups: GROUPS, items, orders, members: MEMBERS_FIXTURE } },
  token,
)
check('API 整板注入 8 张验收卡（7 日期列）', put.status === 200, `PUT=${put.status}`)

let browser
try {
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
  const openCard = (title) =>
    page.evaluate((t) => {
      const el = [...document.querySelectorAll('[data-card-title]')].find((n) => n.textContent === t)
      el?.closest('.group')?.click()
      return !!el
    }, title)

  /** 三层色差实锤：页面底 / 普通列底 / 周末列底 / 卡白 / inset 格 computed 值 */
  const layerCheck = async (tag, expect) => {
    const r = await page.evaluate(() => {
      const page_ = document.querySelector('[data-board-root]') ?? document.body
      const col = document.querySelector('[data-group-key]:not([data-group-column="ungrouped"])')
      const colBody = col?.querySelector('.bg-col, .bg-col-weekend')
      const card = document.querySelector('[data-card-id]')
      const inset = document.querySelector('[data-status-seg]')
      const g = (el) => (el ? getComputedStyle(el).backgroundColor : null)
      return {
        pageBg: g(document.querySelector('.bg-page') ?? page_),
        colBg: g(colBody),
        cardBg: g(card),
        insetBg: g(inset),
        dark: document.documentElement.classList.contains('dark'),
      }
    })
    const ok =
      !!r &&
      r.pageBg === expect.page &&
      r.colBg === expect.col &&
      (expect.card === null || r.cardBg === expect.card) &&
      (expect.inset === null || r.insetBg === expect.inset)
    check(`${tag} 三层色差 + inset`, ok, JSON.stringify(r))
    return r
  }

  // ================= 亮主题 =================
  await page.evaluateOnNewDocument(() => {
    try {
      if (!localStorage.getItem('timeline-theme')) localStorage.setItem('timeline-theme', 'light')
    } catch {}
  })
  await page.goto(`${WEB}/`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => !!document.querySelector('[data-oauth-login]'), { timeout: 15000 })
  await page.evaluate(() => document.querySelector('[data-oauth-login]')?.click())
  await page.waitForFunction(() => !!document.querySelector('[data-board-table]'), { timeout: 20000 })
  await sleep(1800) // 品牌面入场落定

  // 点行走查板 → 密码门 → 进板
  await page.evaluate((name) => {
    const row = [...document.querySelectorAll('[data-board-row]')].find((r) => r.textContent.includes(name))
    row?.querySelector('[data-board-open]')?.click()
  }, BOARD_NAME)
  await page.waitForSelector('[data-gate-password]', { timeout: 15000 })
  await page.type('[data-gate-password]', BOARD_PASS)
  await page.click('[data-gate-submit]')
  await page.waitForSelector('[data-theme-toggle]', { timeout: 15000 })
  await page.waitForFunction(() => document.querySelectorAll('[data-card-title]').length === 8, { timeout: 20000 })
  await page.evaluate(() => {
    ;[...document.querySelectorAll('button')].find((b) => b.textContent.includes('回到今天'))?.click()
  })
  await sleep(1000)

  // e-01 看板主界面（亮）：三层色差 + 周末列深一档 + 今天列橙 accent + minimap
  await shot('e-01-board-light.png')
  await layerCheck('e-01 看板（亮）', {
    page: 'rgb(240, 237, 237)',
    col: 'rgb(232, 229, 233)',
    card: 'rgb(255, 255, 255)',
    inset: null,
  })

  // e-02 详情弹窗（亮）：信息格/状态分段/评论项 = inset 底
  check('打开详情弹窗（亮）', await openCard('校准走查 · 数据周报'))
  await page.waitForFunction(() => !!document.querySelector('[data-comments-item]'), { timeout: 8000 })
  await sleep(500)
  await shot('e-02-detail-light.png')
  await layerCheck('e-02 详情（亮）', {
    page: 'rgb(240, 237, 237)',
    col: 'rgb(232, 229, 233)',
    card: null,
    inset: 'rgb(235, 232, 235)',
  })
  await page.keyboard.press('Escape')
  await sleep(400)

  // e-03 关系图（亮）：边色走 --graph-edge 变量
  await page.click('[data-view-tab="graph"]')
  await page.waitForFunction(() => !!document.querySelector('[data-graph-edge]'), { timeout: 8000 })
  await sleep(800)
  await shot('e-03-graph-light.png')
  const edgeLight = await page.evaluate(() => {
    const el = document.querySelector('[data-graph-edge].graph-edge')
    return el ? getComputedStyle(el).stroke : null
  })
  check('e-03 关系图边色（亮 = 新 slate-300 灰紫）', edgeLight === 'rgb(207, 203, 210)', String(edgeLight))
  await page.click('[data-view-tab="timeline"]')
  await sleep(600)

  // e-04 搜索面板（亮）
  await page.click('[data-search-btn]')
  await page.waitForSelector('[data-search-input]', { timeout: 8000 })
  await page.type('[data-search-input]', '直播')
  await sleep(400)
  await shot('e-04-search-light.png')
  check('e-04 搜索面板（亮）结果非空', await page.evaluate(() => document.querySelectorAll('[data-search-result]').length > 0))
  await page.keyboard.press('Escape')
  await sleep(400)

  // ================= 暗主题（TopBar 开关原地切，不 reload 保会话） =================
  await page.click('[data-theme-toggle]')
  await page.waitForFunction(() => document.documentElement.classList.contains('dark'), { timeout: 5000 })
  await sleep(800)

  // e-05 看板主界面（暗）：黑底 < 列底 < 卡片面 层级保持
  await shot('e-05-board-dark.png')
  const darkLayers = await page.evaluate(() => {
    const g = (el) => (el ? getComputedStyle(el).backgroundColor : null)
    const col = document.querySelector('[data-group-key]:not([data-group-column="ungrouped"]) .bg-col, [data-group-key]:not([data-group-column="ungrouped"]) .bg-col-weekend')
    return {
      pageBg: g(document.querySelector('.bg-page')),
      colBg: g(col),
      cardBg: g(document.querySelector('[data-card-id]')),
      minimapBg: g(document.querySelector('[data-minimap]')?.parentElement),
      dark: document.documentElement.classList.contains('dark'),
    }
  })
  check(
    'e-05 看板（暗）列底介于黑底与卡片面之间',
    darkLayers.dark === true &&
      darkLayers.pageBg === 'rgb(0, 0, 0)' &&
      !!darkLayers.colBg &&
      darkLayers.colBg !== 'rgb(0, 0, 0)' &&
      darkLayers.colBg !== darkLayers.cardBg,
    JSON.stringify(darkLayers),
  )

  // e-06 详情弹窗（暗）
  check('打开详情弹窗（暗）', await openCard('校准走查 · 数据周报'))
  await page.waitForFunction(() => !!document.querySelector('[data-comments-item]'), { timeout: 8000 })
  await sleep(500)
  await shot('e-06-detail-dark.png')
  const insetDark = await page.evaluate(() => {
    const g = (el) => (el ? getComputedStyle(el).backgroundColor : null)
    return { seg: g(document.querySelector('[data-status-seg]')), cmt: g(document.querySelector('[data-comments-item]')) }
  })
  check(
    'e-06 详情（暗）inset = 近黑暖灰一档',
    insetDark.seg === 'rgb(30, 27, 35)' && insetDark.cmt === 'rgb(30, 27, 35)',
    JSON.stringify(insetDark),
  )
  await page.keyboard.press('Escape')
  await sleep(400)

  // e-07 关系图（暗，重点复查）
  await page.click('[data-view-tab="graph"]')
  await page.waitForFunction(() => !!document.querySelector('[data-graph-edge]'), { timeout: 8000 })
  await sleep(800)
  await shot('e-07-graph-dark.png')
  const edgeDark = await page.evaluate(() => {
    const normal = document.querySelector('[data-graph-edge].graph-edge')
    const front = document.querySelector('[data-graph-edge].graph-edge-front')
    return {
      edge: normal ? getComputedStyle(normal).stroke : null,
      front: front ? getComputedStyle(front).stroke : null,
    }
  })
  check(
    'e-07 关系图边色（暗 = 中性化暖灰 / 前线橙提亮）',
    edgeDark.edge === 'rgb(82, 76, 92)' && edgeDark.front === 'rgb(255, 106, 51)',
    JSON.stringify(edgeDark),
  )
  await page.click('[data-view-tab="timeline"]')
  await sleep(600)

  // e-08 搜索面板（暗）
  await page.click('[data-search-btn]')
  await page.waitForSelector('[data-search-input]', { timeout: 8000 })
  await page.type('[data-search-input]', '直播')
  await sleep(400)
  await shot('e-08-search-dark.png')
  check('e-08 搜索面板（暗）结果非空', await page.evaluate(() => document.querySelectorAll('[data-search-result]').length > 0))
  await page.keyboard.press('Escape')
  await sleep(300)

  check('无页面运行时错误', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '))
} finally {
  if (browser) await browser.close().catch(() => {})
}

const failed = checks.filter(([, ok]) => !ok)
console.log(`\n[shots-visual-e] ${checks.length - failed.length} PASS / ${failed.length} FAIL → ${OUT}`)
process.exit(failed.length ? 1 : 0)
