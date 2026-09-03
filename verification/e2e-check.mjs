#!/usr/bin/env node
/**
 * v16 e2e 验证脚本（滑动窗口虚拟化 + minimap + 容量上限 + 键盘导航）
 *
 * 该文件为重建版：覆盖核心回归（密码门/首屏定位/加卡/改期/拖拽/删除/同步/外部注入）
 * + v16 全部新特性（61 列恒定窗口、滑动补偿连续性、minimap 结构/点击/拖拽、
 *   拖拽边界、B2 视野跟随、键盘导航、软上限 1500 警示、硬上限 2000 拒绝）。
 *
 * v17 minimap 纯表现层重设计适配（t03/t07/t08 改写 + t54–t56 新增，共 56 项）：
 *   跨度 = 首卡→末卡；密度 = 量化圆点（1-2 张=1 点、3-5 张=2 点、≥6 张=3 点）；
 *   视口框 = 可见视口真实比例（最小 10px）+ 框顶中心刻度，拖拽框先行（transform 直写）；
 *   压暗 = 61 天加载窗口外左右两片遮罩（随窗口滑动；跨度 <61 天隐藏）；今天 = rose 红点；
 *   日期 tooltip：悬停读所指日期、拖框读框中心日期。
 *
 * v15 旧套件（工作区根 verification/e2e-check.mjs，37 项）全量移植为 t20–t53：
 *   首页建板直进/引导卡/内置产品目录/FAB 隐藏/CLI 导入接管建数据板/inline 编辑与 Esc 取消/
 *   数据板增卡删卡跨日拖/详情字段（指标、rate 反推、非法抖动、归属产品、改期）/类型切换/
 *   长备注滚动/持久化 reload/产品管理增删改/产品独立导入建板/未知归属降级/UI 导入报告与幂等/
 *   目录差分登记/状态联动与旧档迁移/负责人与成员管理/导入按姓名登记成员/密码门 5 次锁定/
 *   双端同步/LWW/离线补推/同步状态点/CLI 空归属导入/删除看板全链路。
 *   v16 窗口化适配：卡片计数一律按「窗口 [首列,末列] 内应渲染数」校验，不再假设全量渲染；
 *   固定日期锚点（examples/import-sample.json）与旧套件一致，要求运行日落在样例数据 ±30 天窗口内。
 *
 * 运行：node verification/e2e-check.mjs
 *   - 自带 fixture：spawn API server（:5198，独立 tmp sqlite）+ vite（:5199，API_PORT=5198 反代）
 *   - 驱动本机 Chrome（headless）走真实 UI；跑完杀进程组 + 删 tmp sqlite + 删 CLI 产物 board.json
 *   - 截图存 verification/board-v16-*.png
 *
 * 端口纪律：5198/5199 本脚本独占（启动前检查，被占则报错退出）；7100/7101/7102 永远不碰。
 */
import { execSync, spawn } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, rmdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import puppeteer from 'puppeteer-core'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const VDIR = path.join(ROOT, 'verification')
mkdirSync(VDIR, { recursive: true })

const API_PORT = 5198
const WEB_PORT = 5199
const API = `http://localhost:${API_PORT}`
const WEB = `http://localhost:${WEB_PORT}`
const DB = path.join(VDIR, 'tmp-e2e.sqlite')
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const VIEW = { width: 1600, height: 900 }
const MAIN_PASS = 'e2e-main-pass'
const GATE_PASS = 'e2e-gate-pass'
const SMALL_NAME = 'E2E 小跨度板'
const SMALL_PASS = 'e2e-small-pass'

// v15 移植用例的固定锚点（与旧套件一致：examples/import-sample.json 内容固定）
const BOARD_JSON = path.join(ROOT, 'public', 'data', 'board.json')
const GUIDE_NAME = 'E2E 引导板'
const GUIDE_PASS = 'e2e-guide-pass'
const DATA_NAME = 'E2E 数据板'
const DATA_PASS = 'e2e-data-pass'
const PROD_NAME = 'E2E 产品板'
const PROD_PASS = 'e2e-prod-pass'
const GUIDE_TITLE_1 = '欢迎使用拾光轴 · 5 分钟上手'
const GUIDE_TITLE_2 = 'CLI 批量导入真实数据'
const EDIT_TARGET_TITLE = '数据日报 · 8 月合集' // imp-0005 @ 2026-09-01（历史已发布）
const DELETE_TARGET_TITLE = '台灯新品图文首发' // imp-0006 @ 2026-09-04（待发布）

// ---------------------------------------------------------------------------
// 日期工具（与 src/lib/content-data.ts 同口径：本地时区）
// ---------------------------------------------------------------------------
const p2 = (n) => String(n).padStart(2, '0')
const fmt = (d) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`
const TODAY = fmt(new Date())
const addDays = (date, n) => {
  const [y, m, d] = date.split('-').map(Number)
  return fmt(new Date(y, m - 1, d + n))
}
const dayDiff = (a, b) => {
  const [y1, m1, d1] = a.split('-').map(Number)
  const [y2, m2, d2] = b.split('-').map(Number)
  return Math.round((new Date(y1, m1 - 1, d1) - new Date(y2, m2 - 1, d2)) / 86400000)
}

const COLUMN_STEP = 248 // 236 列宽 + 12 间距
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
/** 与 BoardMinimap.fmtTip 同口径：「9月15日 周二」 */
const fmtTipDate = (date) => {
  const [y, m, d] = date.split('-').map(Number)
  return `${m}月${d}日 周${'日一二三四五六'[new Date(y, m - 1, d).getDay()]}`
}

function ok(cond, msg) {
  if (!cond) throw new Error(msg)
}
function eq(a, b, msg) {
  if (a !== b) throw new Error(`${msg}：期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`)
}

// ---------------------------------------------------------------------------
// API 直连（绕开页面，供 fixture 注入/核验）
// ---------------------------------------------------------------------------
async function api(method, p, body, token) {
  const res = await fetch(`${API}/api${p}`, {
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
    // 204 无 body
  }
  return { status: res.status, body: json }
}

// ---------------------------------------------------------------------------
// fixture：12 张卡落在 today ±29 内（全在初始窗口内）
// ---------------------------------------------------------------------------
function fixtureDoc(name) {
  const offsets = [-90, -29, -12, -5, -2, 0, 0, 1, 4, 9, 15, 22, 29, 90]
  const perDay = {}
  const orders = {}
  const items = offsets.map((off, i) => {
    const date = addDays(TODAY, off)
    const idx = perDay[date] ?? 0
    perDay[date] = idx + 1
    const id = `e2e-c${p2(i + 1)}`
    orders[id] = idx
    const past = off < 0
    return {
      id,
      title: `E2E 卡 ${p2(i + 1)}`,
      type: '图文',
      publish_at: `${date}T10:${p2(i % 60)}`,
      roi: past ? 2.5 : null,
      comment: '',
      product_id: 'P-1000',
      status: past ? '已发布' : '待发布',
      content_owner_id: '',
      delivery_owner_id: '',
      propagation_4h: past ? 12000 : null,
      engagement_4h: past ? 800 : null,
    }
  })
  return {
    items,
    orders,
    products: [{ id: 'P-1000', name: '光轴' }],
    members: [
      { id: 'M-1001', name: '林晓' },
      { id: 'M-1002', name: '陈远' },
    ],
    meta: { name, created_at: new Date().toISOString() },
  }
}

/** v17 小跨度板 fixture：today-5×1 张、today×3 张、today+5×6 张（跨度 11 天，点级 1/2/3） */
function smallFixtureDoc(name) {
  const plan = [
    { off: -5, n: 1 },
    { off: 0, n: 3 },
    { off: 5, n: 6 },
  ]
  const items = []
  const orders = {}
  let seq = 0
  for (const { off, n } of plan) {
    const date = addDays(TODAY, off)
    for (let i = 0; i < n; i++) {
      seq += 1
      const id = `e2e-s${p2(seq)}`
      orders[id] = i
      const past = off < 0
      items.push({
        id,
        title: `E2E 小卡 ${p2(seq)}`,
        type: '图文',
        publish_at: `${date}T09:${p2(i)}`,
        roi: past ? 1.5 : null,
        comment: '',
        product_id: 'P-1000',
        status: past ? '已发布' : '待发布',
        content_owner_id: '',
        delivery_owner_id: '',
        propagation_4h: null,
        engagement_4h: null,
      })
    }
  }
  return {
    items,
    orders,
    products: [{ id: 'P-1000', name: '光轴' }],
    members: [],
    meta: { name, created_at: new Date().toISOString() },
  }
}

/** 窗口外填充卡（全部落在 2025 年，不渲染、轻量），用于容量用例 */
function fillerItems(n, startIdx, orders) {
  const perDay = {}
  const items = []
  for (let i = 0; i < n; i++) {
    const date = fmt(new Date(2025, 0, 1 + (i % 364)))
    const idx = perDay[date] ?? 0
    perDay[date] = idx + 1
    const id = `filler-${p2(startIdx + i)}`
    orders[id] = idx
    items.push({
      id,
      title: `填充卡 ${startIdx + i}`,
      type: '图文',
      publish_at: `${date}T08:00`,
      roi: null,
      comment: '',
      product_id: 'P-1000',
      status: '待发布',
      content_owner_id: '',
      delivery_owner_id: '',
      propagation_4h: null,
      engagement_4h: null,
    })
  }
  return items
}

// ---------------------------------------------------------------------------
// 进程与浏览器管理
// ---------------------------------------------------------------------------
let apiProc = null
let webProc = null
let browser = null
let page = null

async function portBusy(port) {
  try {
    await fetch(`http://localhost:${port}/`, { signal: AbortSignal.timeout(800) })
    return true
  } catch {
    return false
  }
}

async function waitHttp(url, timeout = 25000) {
  const t0 = Date.now()
  for (;;) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(1000) })
      if (r.ok) return
    } catch {
      // 还没起来
    }
    if (Date.now() - t0 > timeout) throw new Error(`等待服务超时：${url}`)
    await sleep(300)
  }
}

async function startServers() {
  for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) rmSync(f, { force: true })
  // 上轮残留的 CLI 导入产物会污染「本机初始化」用例（t20/t24/t40），启动前清掉
  rmSync(BOARD_JSON, { force: true })
  try {
    rmdirSync(path.dirname(BOARD_JSON))
  } catch {
    // 非空则保留
  }
  const apiLog = createWriteStream(path.join(VDIR, 'e2e-api.log'))
  const webLog = createWriteStream(path.join(VDIR, 'e2e-web.log'))
  apiProc = spawn(process.execPath, [path.join(ROOT, 'server/index.mjs')], {
    cwd: ROOT,
    detached: true,
    env: {
      ...process.env,
      API_PORT: String(API_PORT),
      BOARD_DB: DB,
      BOARD_SECRET: 'e2e-fixed-secret',
      BOARD_LOCK_SECONDS: '2',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  apiProc.stdout.pipe(apiLog)
  apiProc.stderr.pipe(apiLog)
  webProc = spawn(
    process.execPath,
    [path.join(ROOT, 'node_modules/vite/bin/vite.js'), '--port', String(WEB_PORT), '--strictPort'],
    {
      cwd: ROOT,
      detached: true,
      env: { ...process.env, API_PORT: String(API_PORT) },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  webProc.stdout.pipe(webLog)
  webProc.stderr.pipe(webLog)
  await waitHttp(`${API}/api/health`)
  await waitHttp(`${WEB}/`)
}

function killProcGroup(p) {
  if (!p || p.killed) return
  try {
    process.kill(-p.pid, 'SIGKILL') // detached 组：连 esbuild 等子进程一起杀
  } catch {
    try {
      p.kill('SIGKILL')
    } catch {
      // 已退出
    }
  }
}

async function teardown() {
  if (browser) {
    try {
      await browser.close()
    } catch {
      // ignore
    }
  }
  killProcGroup(webProc)
  killProcGroup(apiProc)
  await sleep(300)
  for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) rmSync(f, { force: true })
  // 清理 CLI 导入产物：仓库默认体验保持「两张引导卡」（旧套件同款纪律）
  rmSync(BOARD_JSON, { force: true })
  try {
    rmdirSync(path.dirname(BOARD_JSON))
  } catch {
    // 非空则保留
  }
  for (const f of ['tmp-v12-ui-import.json', 'tmp-v13-diff-import.json', 'tmp-v14-member-import.json', 'tmp-v11-empty-product.csv']) {
    try {
      rmSync(path.join(VDIR, f), { force: true })
    } catch {
      // ignore
    }
  }
}

// ---------------------------------------------------------------------------
// 页面操作 helpers
// ---------------------------------------------------------------------------
const ev = (fn, ...args) => page.evaluate(fn, ...args)

async function waitFor(fn, timeout = 9000, label = '') {
  const t0 = Date.now()
  for (;;) {
    let v
    try {
      v = await fn()
    } catch {
      v = null
    }
    if (v) return v
    if (Date.now() - t0 > timeout) throw new Error(`waitFor 超时${label ? `：${label}` : ''}`)
    await sleep(120)
  }
}

const colCount = () => ev(() => document.querySelectorAll('.h-full.overflow-auto [data-date]').length)
const firstDate = () =>
  ev(() => document.querySelector('.h-full.overflow-auto [data-date]')?.dataset.date ?? null)
const midDate = () =>
  ev(() => {
    const s = document.querySelector('.h-full.overflow-auto')
    if (!s) return null
    const cols = [...s.querySelectorAll('[data-date]')]
    if (!cols.length) return null
    const idx = Math.round((s.scrollLeft + s.clientWidth / 2 - 16 - 118) / 248)
    return cols[Math.max(0, Math.min(cols.length - 1, idx))]?.dataset.date ?? null
  })
const dateVisible = (date) =>
  ev((d) => {
    const s = document.querySelector('.h-full.overflow-auto')
    const c = s?.querySelector(`[data-date="${d}"]`)
    if (!s || !c) return false
    const sr = s.getBoundingClientRect()
    const cr = c.getBoundingClientRect()
    return cr.left < sr.right && cr.right > sr.left
  }, date)
/** 卡片标题 → 所在列日期（DOM 内找不到返回 null） */
const cardColumnDate = (title) =>
  ev((t) => {
    const el = [...document.querySelectorAll('.h-full.overflow-auto [data-card-title]')].find(
      (p) => p.textContent === t,
    )
    return el ? (el.closest('[data-date]')?.dataset.date ?? null) : null
  }, title)

async function openCard(title) {
  await ev((t) => {
    const el = [...document.querySelectorAll('.h-full.overflow-auto [data-card-title]')].find(
      (p) => p.textContent === t,
    )
    el?.closest('.group')?.click()
  }, title)
  await waitFor(() => ev(() => !!document.querySelector('[data-slot="dialog-content"]')), 4000, '详情弹窗打开')
}

async function closeDialog() {
  await page.keyboard.press('Escape')
  await waitFor(() => ev(() => !document.querySelector('[data-slot="dialog-content"]')), 4000, '详情弹窗关闭')
}

/** 详情页改 publish_at：datetime-local 受控输入用 native setter + input 事件，blur 提交 */
async function editPublishAt(v) {
  await ev(() => document.querySelector('[data-edit-field="publish_at"]')?.click())
  await waitFor(() => ev(() => !!document.querySelector('[data-edit-input="publish_at"]')), 4000, 'publish_at 输入框')
  await ev((val) => {
    const el = document.querySelector('[data-edit-input="publish_at"]')
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(el, val)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }, v)
  await sleep(150)
  await ev(() => {
    const el = document.querySelector('[data-edit-input="publish_at"]')
    el?.blur()
    el?.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
  })
  await sleep(250)
}

/** 受控文本输入置空再输入（clearAndType：native setter 写法，headless 下三连击/全选不可靠） */
async function clearAndType(selector, text) {
  await ev((sel) => {
    const el = document.querySelector(sel)
    if (!el) return
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(el, '')
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }, selector)
  await page.click(selector)
  await page.keyboard.type(text, { delay: 10 })
}

// ---------------------------------------------------------------------------
// v15 移植 helpers（语义与旧套件一致，适配 v16 窗口）
// ---------------------------------------------------------------------------

/** 指定板的缓存 doc（localStorage 整份，同步层 effect 落盘）——持久化断言统一入口 */
const storedDoc = (bid) =>
  ev((k) => JSON.parse(localStorage.getItem(k) ?? 'null'), `timeline-board-v4:b:${bid}`)
const storedItem = async (bid, title) =>
  (await storedDoc(bid))?.items?.find((i) => i.title === title) ?? null

const lastDate = () =>
  ev(() => {
    const cols = [...document.querySelectorAll('.h-full.overflow-auto [data-date]')]
    return cols[cols.length - 1]?.dataset.date ?? null
  })
const renderedCount = () =>
  ev(() => document.querySelectorAll('.h-full.overflow-auto [data-card-title]').length)
/** v16 窗口语义：doc 中 publish 日期落在 [first,last] 内的条目数 = 应渲染数 */
const inWindowCount = (doc, first, last) =>
  doc.items.filter((i) => {
    const d = i.publish_at.slice(0, 10)
    return d >= first && d <= last
  }).length

/** 卡面归属产品显示（文本 + tooltip），不明降级核验用 */
const cardFaceProduct = (title) =>
  ev((t) => {
    const el = [...document.querySelectorAll('.h-full.overflow-auto [data-card-title]')].find(
      (p) => p.textContent === t,
    )
    const pe = el?.closest('.group')?.querySelector('[data-card-product]')
    return pe ? { text: pe.textContent ?? null, title: pe.getAttribute('title') } : null
  }, title)

/** vite dev 对 public/ 有感知/缓存延迟：轮询直到伺服内容 importedAt 与磁盘一致（旧套件同款） */
async function waitViteServes(expect) {
  const deadline = Date.now() + 15000
  for (;;) {
    try {
      const r = await fetch(`${WEB}/data/board.json`, { cache: 'no-store' })
      if (expect !== null && r.ok) {
        const j = await r.json()
        if (j?.importedAt === expect) return
      }
    } catch {
      // 连接失败继续等到 deadline
    }
    if (Date.now() > deadline)
      throw new Error('vite 15s 内未同步 public/data/board.json')
    await sleep(300)
  }
}

/** 详情指标格编辑（旧 editNum 同款）：点字段 → native 清空 → 输入 → Enter */
async function editNum(field, value) {
  await ev((f) => document.querySelector(`[data-edit-field="${f}"]`)?.click(), field)
  await waitFor(
    () => ev((f) => !!document.querySelector(`[data-edit-input="${f}"]`), field),
    4000,
    `${field} 输入框`,
  )
  await ev((f) => {
    const el = document.querySelector(`[data-edit-input="${f}"]`)
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(el, '')
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }, field)
  await page.keyboard.type(value, { delay: 10 })
  await page.keyboard.press('Enter')
  await sleep(300)
}

/** 指定页面版 clearAndType（多浏览器上下文用例） */
async function clearAndTypeOn(pg, selector, text) {
  await pg.evaluate((sel) => {
    const el = document.querySelector(sel)
    if (!el) return
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(el, '')
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }, selector)
  await pg.click(selector)
  await pg.keyboard.type(text, { delay: 10 })
}

/** 指定页面改卡标题（同步用例复用）：开卡 → 点标题 → 清空输入 → Enter → Esc 关弹窗 */
async function editCardTitleOn(pg, title, newTitle) {
  await pg.evaluate((t) => {
    const el = [...document.querySelectorAll('.h-full.overflow-auto [data-card-title]')].find(
      (p) => p.textContent === t,
    )
    el?.closest('.group')?.click()
  }, title)
  await pg.waitForFunction(() => !!document.querySelector('[data-slot="dialog-content"]'), {
    timeout: 6000,
  })
  await pg.evaluate(() => document.querySelector('[data-detail-title]')?.click())
  await pg.waitForFunction(() => !!document.querySelector('input[placeholder="输入卡片标题…"]'), {
    timeout: 5000,
  })
  await clearAndTypeOn(pg, 'input[placeholder="输入卡片标题…"]', newTitle)
  await pg.keyboard.press('Enter')
  await pg.waitForFunction((t) => document.querySelector('[data-detail-title]')?.textContent === t, { timeout: 6000 }, newTitle)
  await pg.keyboard.press('Escape')
  await pg.waitForFunction(() => !document.querySelector('[data-slot="dialog-content"]'), {
    timeout: 6000,
  })
  await sleep(300)
}

// ---------------------------------------------------------------------------
// 用例主流程
// ---------------------------------------------------------------------------
const results = []
async function t(name, fn) {
  try {
    await fn()
    results.push(['PASS', name])
    console.log(`  ✓ ${name}`)
  } catch (e) {
    results.push(['FAIL', name, e])
    console.error(`  ✗ ${name} — ${e instanceof Error ? e.message : String(e)}`)
  }
}

async function main() {
  // 端口纪律：5198/5199 被占则直接退出（不杀别人的进程）
  if ((await portBusy(API_PORT)) || (await portBusy(WEB_PORT))) {
    throw new Error(`端口 ${API_PORT}/${WEB_PORT} 被占用，请先释放再跑 e2e`)
  }
  if (!existsSync(CHROME)) throw new Error(`找不到本机 Chrome：${CHROME}`)

  await startServers()
  console.log('[e2e] API :5198 + vite :5199 已就绪')

  // fixture 建板：主板（14 卡，含 ±90 出窗离群卡 2 张）+ 空板（密码门/删除用例）
  const mainDoc = fixtureDoc('E2E 主板')
  const mk = await api('POST', '/boards', { name: 'E2E 主板', password: MAIN_PASS, doc: mainDoc })
  eq(mk.status, 201, '创建主板')
  const boardId = mk.body.board_id
  const auth = await api('POST', `/boards/${boardId}/auth`, { password: MAIN_PASS })
  eq(auth.status, 200, '主板 auth')
  const token = auth.body.token

  const gateDoc = { items: [], orders: {}, products: [], members: [], meta: { name: 'E2E 空板', created_at: new Date().toISOString() } }
  const gk = await api('POST', '/boards', { name: 'E2E 空板', password: GATE_PASS, doc: gateDoc })
  eq(gk.status, 201, '创建空板')
  const gateId = gk.body.board_id

  // v17 小跨度板：跨度 11 天（today-5 → today+5，共 10 卡），验证量化点级与「跨度 <61 天无压暗」
  const smallDoc = smallFixtureDoc(SMALL_NAME)
  const sk = await api('POST', '/boards', { name: SMALL_NAME, password: SMALL_PASS, doc: smallDoc })
  eq(sk.status, 201, '创建小跨度板')
  const smallId = sk.body.board_id
  const sauth = await api('POST', `/boards/${smallId}/auth`, { password: SMALL_PASS })
  eq(sauth.status, 200, '小跨度板 auth')
  const smallToken = sauth.body.token

  browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--disable-gpu', '--hide-scrollbars', '--window-size=1600,900'],
    defaultViewport: VIEW,
  })
  page = await browser.newPage()
  await page.setCacheEnabled(false) // 保证 CLI 导入后首页一定拿到新 board.json（旧套件同款）
  page.on('pageerror', (e) => console.error('  [pageerror]', String(e).slice(0, 200)))

  // 预置主板 token，随后各用例在同一标签页内导航
  await page.goto(`${WEB}/`, { waitUntil: 'domcontentloaded' })
  await ev((k, tk) => sessionStorage.setItem(k, tk), `timeline-board-v4:token:${boardId}`, token)

  const OUTLIER_PAST = addDays(TODAY, -90)
  const OUTLIER_FUTURE = addDays(TODAY, 90)

  await t('t01 密码门：错误密码报错 → 正确密码进板', async () => {
    await page.goto(`${WEB}/b/${gateId}?poll=1000&push=200`, { waitUntil: 'domcontentloaded' })
    await waitFor(() => ev(() => !!document.querySelector('[data-gate]')), 8000, '密码门出现')
    await clearAndType('[data-gate-password]', 'wrong-pass')
    await waitFor(() => ev(() => document.querySelector('[data-gate-submit]')?.disabled === false), 8000, '看板名加载')
    await ev(() => document.querySelector('[data-gate-submit]')?.click())
    await waitFor(() => ev(() => !!document.querySelector('[data-gate-error]')), 5000, '错误密码报错')
    await clearAndType('[data-gate-password]', GATE_PASS)
    await waitFor(() => ev(() => document.querySelector('[data-gate-submit]')?.disabled === false), 5000, '重输后可提交')
    await ev(() => document.querySelector('[data-gate-submit]')?.click())
    await waitFor(async () => (await colCount()) === 61, 9000, '进板渲染 61 列')
    const cards = await ev(() => document.querySelectorAll('.h-full.overflow-auto [data-card-title]').length)
    eq(cards, 0, '空板无卡片')
  })

  await t('t02 首屏：恒定 61 列 = 今天 ±30，今天列可见，窗口内卡 12 张', async () => {
    await page.goto(`${WEB}/b/${boardId}?poll=1000&push=200`, { waitUntil: 'domcontentloaded' })
    await waitFor(async () => (await colCount()) === 61, 9000, '渲染 61 列')
    eq(await firstDate(), addDays(TODAY, -30), '首列 = 今天-30')
    const last = await ev(() => {
      const cols = [...document.querySelectorAll('.h-full.overflow-auto [data-date]')]
      return cols[cols.length - 1]?.dataset.date
    })
    eq(last, addDays(TODAY, 30), '末列 = 今天+30')
    ok(await dateVisible(TODAY), '今天列首屏可见')
    const cards = await ev(() => document.querySelectorAll('.h-full.overflow-auto [data-card-title]').length)
    eq(cards, 12, '窗口内渲染 12 张（±90 两张离群卡不渲染）')
    // 出窗离群卡不在 DOM
    eq(await cardColumnDate('E2E 卡 01'), null, 'today-90 离群卡不渲染')
    await sleep(400)
    await page.screenshot({ path: path.join(VDIR, 'board-v17-minimap.png') })
  })

  // v17：span = 首卡 today-90 → 末卡 today+90 = 181 天；窗口 today±30 → 左右各遮 60 天
  await t('t03 minimap v17 结构：量化圆点/视口框真实比例/今天点/压暗/月刻度', async () => {
    ok(await ev(() => !!document.querySelector('[data-minimap]')), '轨道存在')
    ok(await ev(() => !!document.querySelector('[data-minimap-window]')), '视口框存在')
    ok(await ev(() => !!document.querySelector('[data-minimap-today]')), '今天点存在')
    ok(await ev(() => !!document.querySelector('[data-minimap-viewport-tick]')), '框顶中心刻度存在')
    const months = await ev(() => document.querySelectorAll('[data-minimap-month]').length)
    ok(months >= 2, `月刻度 ${months} ≥ 2`)
    // 14 张卡落在 13 个不同日期（今天 2 张同日）→ 13 列，每天 ≤2 张 → 各 1 点
    eq(await ev(() => document.querySelectorAll('[data-minimap-daycol]').length), 13, '13 个日期列')
    eq(await ev(() => document.querySelectorAll('[data-minimap-dot]').length), 13, '每天 1 点共 13 点')
    const todayDots = await ev(
      (d) => document.querySelector(`[data-minimap-daycol][data-date="${d}"]`)?.querySelectorAll('[data-minimap-dot]').length ?? -1,
      TODAY,
    )
    eq(todayDots, 1, '今天列（2 张）= 1 点')
    // 视口框宽 ≈ 可见视口天数 / 181（真实比例），且 ≥ 10px 最小宽
    const fw = await ev(() => {
      const t = document.querySelector('[data-minimap]').getBoundingClientRect()
      const f = document.querySelector('[data-minimap-window]').getBoundingClientRect()
      const s = document.querySelector('.h-full.overflow-auto')
      return { ratio: f.width / t.width, expect: s.clientWidth / 248 / 181, px: f.width }
    })
    ok(fw.px >= 10, `视口框宽 ${fw.px.toFixed(1)}px ≥ 10px`)
    ok(
      Math.abs(fw.ratio - fw.expect) < 0.004,
      `视口框宽比 ${(fw.ratio * 100).toFixed(2)}% ≈ ${(fw.expect * 100).toFixed(2)}%（真实比例）`,
    )
    // 压暗：窗口 [today-30, today+30] 外各 60 天 → 左右遮罩宽比 ≈ 60/181
    const dims = await ev(() => {
      const t = document.querySelector('[data-minimap]').getBoundingClientRect()
      const l = document.querySelector('[data-minimap-dim-left]')
      const r = document.querySelector('[data-minimap-dim-right]')
      return {
        lw: l.getBoundingClientRect().width / t.width,
        rw: r.getBoundingClientRect().width / t.width,
        lv: getComputedStyle(l).visibility,
        rv: getComputedStyle(r).visibility,
      }
    })
    eq(dims.lv, 'visible', '左压暗可见')
    eq(dims.rv, 'visible', '右压暗可见')
    ok(Math.abs(dims.lw - 60 / 181) < 0.01, `左压暗宽比 ${(dims.lw * 100).toFixed(1)}% ≈ 33.1%（60/181）`)
    ok(Math.abs(dims.rw - 60 / 181) < 0.01, `右压暗宽比 ${(dims.rw * 100).toFixed(1)}% ≈ 33.1%（60/181）`)
  })

  await t('t04 窗口滑动：scrollLeft 补偿保证视觉连续，列数恒 61', async () => {
    const before = await ev(() => {
      const s = document.querySelector('.h-full.overflow-auto')
      const cols = [...s.querySelectorAll('[data-date]')]
      const idx = Math.round((s.scrollLeft + s.clientWidth / 2 - 16 - 118) / 248)
      const d = cols[Math.max(0, Math.min(cols.length - 1, idx))]
      return { first: cols[0].dataset.date, D: d.dataset.date, left: d.getBoundingClientRect().left }
    })
    await ev(() => {
      document.querySelector('.h-full.overflow-auto').scrollLeft += 12 * 248
    })
    await waitFor(async () => (await firstDate()) !== before.first, 5000, '窗口滑动重建')
    await sleep(250)
    const after = await ev((D) => {
      const s = document.querySelector('.h-full.overflow-auto')
      const cols = [...s.querySelectorAll('[data-date]')]
      const d = cols.find((c) => c.dataset.date === D)
      return { first: cols[0].dataset.date, left: d ? d.getBoundingClientRect().left : null, count: cols.length }
    }, before.D)
    eq(after.count, 61, '滑动后列数恒 61')
    const slid = dayDiff(after.first, before.first)
    ok(slid >= 11 && slid <= 17, `窗口前移 ${slid} 天（预期 14 左右）`)
    ok(after.left !== null, '参照列仍在窗口内')
    const expectLeft = before.left - 12 * COLUMN_STEP
    ok(
      Math.abs(after.left - expectLeft) <= 4,
      `视觉连续：参照列屏位 ${before.left.toFixed(1)} → ${after.left.toFixed(1)}，期望 ${expectLeft.toFixed(1)} ±4`,
    )
  })

  await t('t05 FAB：滑远后出现，点击回到今天', async () => {
    await ev(() => {
      const s = document.querySelector('.h-full.overflow-auto')
      s.scrollLeft = s.scrollWidth
    })
    const fabSel = () =>
      ev(() =>
        [...document.querySelectorAll('button')].some(
          (b) => b.textContent.includes('回到今天') && b.className.includes('rounded-full'),
        ),
      )
    await waitFor(fabSel, 6000, 'FAB 出现')
    ok(!(await dateVisible(TODAY)), '今天列已滚出视口')
    await ev(() => {
      ;[...document.querySelectorAll('button')]
        .find((b) => b.textContent.includes('回到今天') && b.className.includes('rounded-full'))
        ?.click()
    })
    await waitFor(() => dateVisible(TODAY), 8000, 'FAB 回今天')
  })

  await t('t06 键盘：→ +7 天 / Shift+→ +30 天 / ← -7 天 / T 回今天', async () => {
    await ev(() => document.body.focus())
    await sleep(300)
    const m0 = await midDate()
    await page.keyboard.press('ArrowRight')
    await sleep(900)
    const m1 = await midDate()
    ok(Math.abs(dayDiff(m1, m0) - 7) <= 1, `→ 后中线 ${m0} → ${m1}（预期 +7）`)
    await page.keyboard.down('Shift')
    await page.keyboard.press('ArrowRight')
    await page.keyboard.up('Shift')
    await sleep(900)
    const m2 = await midDate()
    ok(Math.abs(dayDiff(m2, m1) - 30) <= 1, `Shift+→ 后中线 ${m1} → ${m2}（预期 +30）`)
    await page.keyboard.press('ArrowLeft')
    await sleep(900)
    const m3 = await midDate()
    ok(Math.abs(dayDiff(m3, m2) + 7) <= 1, `← 后中线 ${m2} → ${m3}（预期 -7）`)
    await page.keyboard.press('t')
    await waitFor(() => dateVisible(TODAY), 8000, 'T 回今天')
    await sleep(500)
    ok(Math.abs(dayDiff(await midDate(), TODAY)) <= 1, 'T 后中线回到今天附近')
  })

  await t('t07 minimap 点击跳转（双向同步）', async () => {
    const pt = await ev(() => {
      const r = document.querySelector('[data-minimap]').getBoundingClientRect()
      return { x: r.left, y: r.top + r.height / 2, w: r.width }
    })
    // v17：span = today-90 → today+90（181 天）；floor 映射：点 85% → today-90 + floor(0.85×181) = today+63
    const expect1 = addDays(TODAY, -90 + Math.floor(0.85 * 181))
    await page.mouse.click(pt.x + pt.w * 0.85, pt.y)
    await waitFor(async () => Math.abs(dayDiff(await midDate(), expect1)) <= 2, 7000, `点击跳到 ${expect1} 附近`)
    // 点回 50% → floor(0.5×181)=90 → today
    await page.mouse.click(pt.x + pt.w * 0.5, pt.y)
    await waitFor(async () => Math.abs(dayDiff(await midDate(), TODAY)) <= 2, 7000, '点击回今天')
  })

  await t('t08 minimap 拖框先行 + tooltip 读数 + 大跳截图', async () => {
    const pt = await ev(() => {
      const r = document.querySelector('[data-minimap]').getBoundingClientRect()
      return { x: r.left, y: r.top + r.height / 2, w: r.width }
    })
    const fr = await ev(() => {
      const r = document.querySelector('[data-minimap-window]').getBoundingClientRect()
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
    })
    const mid60 = pt.x + pt.w * 0.6
    const target97 = pt.x + pt.w * 0.97
    await page.mouse.move(fr.x, fr.y)
    await page.mouse.down()
    try {
      for (let i = 1; i <= 6; i++) {
        await page.mouse.move(fr.x + ((mid60 - fr.x) * i) / 6, fr.y)
        await sleep(45)
      }
      // 框先行：停顿后框中心 ≈ 指针（轮询等收敛，允许滚动跟随路径追平）
      await waitFor(async () => {
        const d = await ev(() => {
          const f = document.querySelector('[data-minimap-window]').getBoundingClientRect()
          return f.left + f.width / 2
        })
        return Math.abs(d - mid60) <= 12
      }, 4000, '拖拽中框中心 ≈ 指针（框先行）')
      // tooltip：拖框时读框中心日期（floor(0.6×181)=108 → today+18）
      const tip60 = fmtTipDate(addDays(TODAY, -90 + Math.floor(0.6 * 181)))
      const tipState = await ev(() => {
        const el = document.querySelector('[data-minimap-tooltip]')
        return { opacity: el.style.opacity, text: el.textContent }
      })
      eq(tipState.opacity, '1', '拖拽中 tooltip 显示')
      eq(tipState.text, tip60, `拖拽中 tooltip 读框中心日期 ${tip60}`)
      await page.screenshot({ path: path.join(VDIR, 'board-v17-drag-tooltip.png') })
      for (let i = 1; i <= 6; i++) {
        await page.mouse.move(mid60 + ((target97 - mid60) * i) / 6, fr.y)
        await sleep(45)
      }
    } finally {
      await page.mouse.up()
    }
    const expectD = addDays(TODAY, -90 + Math.floor(0.97 * 181)) // ≈ today+85
    await waitFor(async () => Math.abs(dayDiff(await midDate(), expectD)) <= 3, 8000, `拖拽大跳到 ${expectD} 附近`)
    // 松开后 tooltip 隐藏
    const tipGone = await ev(() => document.querySelector('[data-minimap-tooltip]').style.opacity)
    eq(tipGone, '0', '松开后 tooltip 隐藏')
    // 点击回今天，恢复后续用例现场
    await page.mouse.click(pt.x + pt.w * 0.5, pt.y)
    await waitFor(async () => Math.abs(dayDiff(await midDate(), TODAY)) <= 2, 8000, '拖回今天')
  })

  await t('t54 minimap 悬停 tooltip 读所指日期 + 移出隐藏', async () => {
    const pt = await ev(() => {
      const r = document.querySelector('[data-minimap]').getBoundingClientRect()
      return { x: r.left, y: r.top + r.height / 2, w: r.width }
    })
    const readTip = () =>
      ev(() => {
        const el = document.querySelector('[data-minimap-tooltip]')
        return { opacity: el.style.opacity, text: el.textContent }
      })
    // 悬停 25% → floor(0.25×181)=45 → today-45
    const tip25 = fmtTipDate(addDays(TODAY, -90 + Math.floor(0.25 * 181)))
    await page.mouse.move(pt.x + pt.w * 0.25, pt.y)
    await waitFor(async () => (await readTip()).opacity === '1', 4000, '悬停 tooltip 显示')
    eq((await readTip()).text, tip25, `悬停 25% 读 ${tip25}`)
    // 移到 75% → floor(0.75×181)=135 → today+45
    const tip75 = fmtTipDate(addDays(TODAY, -90 + Math.floor(0.75 * 181)))
    await page.mouse.move(pt.x + pt.w * 0.75, pt.y)
    await waitFor(async () => (await readTip()).text === tip75, 4000, `悬停 75% 读 ${tip75}`)
    // 移出轨道 → 隐藏
    await page.mouse.move(pt.x + pt.w * 0.75, pt.y - 120)
    await waitFor(async () => (await readTip()).opacity === '0', 4000, '移出轨道 tooltip 隐藏')
  })

  await t('t55 minimap 压暗随窗口滑动：左增右减', async () => {
    // 回到今天（窗口 today±30）
    const pt = await ev(() => {
      const r = document.querySelector('[data-minimap]').getBoundingClientRect()
      return { x: r.left, y: r.top + r.height / 2, w: r.width }
    })
    await page.mouse.click(pt.x + pt.w * 0.5, pt.y)
    await waitFor(async () => Math.abs(dayDiff(await midDate(), TODAY)) <= 2, 8000, '回今天')
    const readDims = () =>
      ev(() => ({
        l: document.querySelector('[data-minimap-dim-left]').getBoundingClientRect().width,
        r: document.querySelector('[data-minimap-dim-right]').getBoundingClientRect().width,
      }))
    const m1 = await readDims()
    const before = await firstDate()
    await ev(() => {
      document.querySelector('.h-full.overflow-auto').scrollLeft += 12 * 248
    })
    await waitFor(async () => (await firstDate()) !== before, 5000, '窗口滑动重建')
    await sleep(300)
    const m2 = await readDims()
    ok(m2.l - m1.l > 50, `左压暗增 ${(m2.l - m1.l).toFixed(1)}px > 50px`)
    ok(m1.r - m2.r > 50, `右压暗减 ${(m1.r - m2.r).toFixed(1)}px > 50px`)
    // 回今天恢复现场
    await page.mouse.click(pt.x + pt.w * 0.5, pt.y)
    await waitFor(async () => Math.abs(dayDiff(await midDate(), TODAY)) <= 2, 8000, '回今天')
  })

  await t('t56 小跨度板：量化点 1/2/3、无压暗、视口框大占比', async () => {
    await ev((k, tk) => sessionStorage.setItem(k, tk), `timeline-board-v4:token:${smallId}`, smallToken)
    await page.goto(`${WEB}/b/${smallId}?poll=1000&push=200`, { waitUntil: 'domcontentloaded' })
    await waitFor(async () => (await colCount()) === 61, 9000, '小板渲染 61 列')
    // 跨度 = today-5 → today+5（11 天）；3 个日期列，点级 1 / 2 / 3
    eq(await ev(() => document.querySelectorAll('[data-minimap-daycol]').length), 3, '3 个日期列')
    eq(await ev(() => document.querySelectorAll('[data-minimap-dot]').length), 6, '总 6 点')
    const levels = await ev(() => {
      const out = {}
      for (const c of document.querySelectorAll('[data-minimap-daycol]')) {
        out[c.dataset.date] = c.querySelectorAll('[data-minimap-dot]').length
      }
      return out
    })
    eq(levels[addDays(TODAY, -5)], 1, 'today-5（1 张）= 1 点')
    eq(levels[TODAY], 2, 'today（3 张）= 2 点')
    eq(levels[addDays(TODAY, 5)], 3, 'today+5（6 张）= 3 点')
    // 跨度 11 < 61：全量已加载，无压暗
    const dv = await ev(() => ({
      l: getComputedStyle(document.querySelector('[data-minimap-dim-left]')).visibility,
      r: getComputedStyle(document.querySelector('[data-minimap-dim-right]')).visibility,
    }))
    eq(dv.l, 'hidden', '左压暗隐藏（跨度 <61 天）')
    eq(dv.r, 'hidden', '右压暗隐藏（跨度 <61 天）')
    // 视口框宽比 ≈ (视口可见天数)/11 ≈ 58%
    const fw = await ev(() => {
      const t = document.querySelector('[data-minimap]').getBoundingClientRect()
      const f = document.querySelector('[data-minimap-window]').getBoundingClientRect()
      const s = document.querySelector('.h-full.overflow-auto')
      return { ratio: f.width / t.width, expect: s.clientWidth / 248 / 11 }
    })
    ok(
      Math.abs(fw.ratio - fw.expect) < 0.03,
      `视口框宽比 ${(fw.ratio * 100).toFixed(1)}% ≈ ${(fw.expect * 100).toFixed(1)}%`,
    )
    ok(await ev(() => !!document.querySelector('[data-minimap-today]')), '今天点存在')
    await sleep(300)
    await page.screenshot({ path: path.join(VDIR, 'board-v17-small-span.png') })
    // 回主板，恢复 t09 现场
    await page.goto(`${WEB}/b/${boardId}?poll=1000&push=200`, { waitUntil: 'domcontentloaded' })
    await waitFor(async () => (await colCount()) === 61, 9000, '回主板渲染 61 列')
    await waitFor(() => dateVisible(TODAY), 8000, '主板今天列可见')
    // 即刻删除小板：t20 起的移植用例假设库内仅主板，不能留下污染
    const del = await api('DELETE', `/boards/${smallId}`, { password: SMALL_PASS })
    eq(del.status, 204, '小板用完即删')
  })

  await t('t09 列底「+ 空卡片」→ 详情自动编辑标题', async () => {
    const d2 = addDays(TODAY, 2)
    await ev((d) => {
      const col = document.querySelector(`[data-date="${d}"]`)
      ;[...col.querySelectorAll('button')].find((b) => b.textContent.includes('+ 空卡片'))?.click()
    }, d2)
    await waitFor(() => ev(() => !!document.querySelector('[data-slot="dialog-content"]')), 5000, '详情弹窗')
    await page.click('input[placeholder="输入卡片标题…"]')
    await page.keyboard.type('E2E 新增卡', { delay: 12 })
    await page.keyboard.press('Enter')
    await waitFor(
      () => ev(() => document.querySelector('[data-detail-title]')?.textContent === 'E2E 新增卡'),
      5000,
      '标题提交',
    )
    await closeDialog()
    await waitFor(async () => (await cardColumnDate('E2E 新增卡')) === d2, 5000, '新卡落在目标列')
  })

  await t('t10 详情页改 publish_at（窗口内）：卡片移到目标列', async () => {
    const target = addDays(TODAY, 5)
    await openCard('E2E 新增卡')
    await editPublishAt(`${target}T18:30`)
    await waitFor(async () => (await cardColumnDate('E2E 新增卡')) === target, 5000, '卡片移到 today+5')
    await closeDialog()
  })

  await t('t11 详情页改 publish_at 出窗（B2）：视野跟随新日期，可改回', async () => {
    const far = addDays(TODAY, 40)
    await openCard('E2E 新增卡')
    await editPublishAt(`${far}T09:00`)
    await waitFor(async () => (await firstDate()) === addDays(TODAY, 10), 7000, '窗口重建（首列 = today+10）')
    await waitFor(async () => (await cardColumnDate('E2E 新增卡')) === far, 5000, '卡片落在 today+40')
    await waitFor(() => dateVisible(far), 7000, 'today+40 列滚入视口')
    // 改回 today+1（视野应跟随回来）
    const back = addDays(TODAY, 1)
    await editPublishAt(`${back}T09:00`)
    await waitFor(async () => (await firstDate()) === addDays(TODAY, -29), 7000, '窗口跟随回 today+1')
    await waitFor(async () => (await cardColumnDate('E2E 新增卡')) === back, 5000, '卡片回到 today+1')
    await closeDialog()
  })

  await t('t12 拖拽跨日：publish_at 日期切换、时分保留', async () => {
    const target = addDays(TODAY, 3)
    const from = await ev(() => {
      const el = [...document.querySelectorAll('.h-full.overflow-auto [data-card-title]')].find(
        (p) => p.textContent === 'E2E 卡 05',
      )
      if (!el) return null
      const r = el.closest('.group').getBoundingClientRect()
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
    })
    ok(from, '找到拖拽源卡')
    const to = await ev((d) => {
      const col = document.querySelector(`[data-date="${d}"]`)
      const r = col.getBoundingClientRect()
      return { x: r.left + 118, y: Math.min(r.top + 320, 800) }
    }, target)
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    try {
      await page.mouse.move(from.x + 30, from.y + 6, { steps: 5 })
      await sleep(80)
      await page.mouse.move(to.x, to.y, { steps: 12 })
      await sleep(280)
    } finally {
      await page.mouse.up()
    }
    await waitFor(async () => (await cardColumnDate('E2E 卡 05')) === target, 6000, '落定到 today+3')
    await sleep(500) // 等 click 抑制解除
  })

  await t('t13 拖拽边界：拖到左缘 autoScroll 期间窗口不滑动，落点在窗口内', async () => {
    const days0 = await firstDate()
    const scroll0 = await ev(() => document.querySelector('.h-full.overflow-auto').scrollLeft)
    const from = await ev(() => {
      const el = [...document.querySelectorAll('.h-full.overflow-auto [data-card-title]')].find(
        (p) => p.textContent === 'E2E 卡 06',
      )
      if (!el) return null
      const r = el.closest('.group').getBoundingClientRect()
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
    })
    ok(from, '找到边界拖拽源卡')
    const sLeft = await ev(() => document.querySelector('.h-full.overflow-auto').getBoundingClientRect().left)
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    let leftColDate = null
    try {
      await page.mouse.move(from.x + 30, from.y + 4, { steps: 4 })
      const edgeX = sLeft + 6
      await page.mouse.move(edgeX, from.y, { steps: 10 })
      for (let i = 0; i < 20; i++) {
        await page.mouse.move(edgeX + (i % 2), from.y + (i % 3))
        await sleep(100)
      }
      const scroll1 = await ev(() => document.querySelector('.h-full.overflow-auto').scrollLeft)
      ok(scroll1 < scroll0, `autoScroll 生效（scrollLeft ${scroll0} → ${scroll1}）`)
      eq(await firstDate(), days0, '拖拽期间窗口未滑动')
      // 移到视口中部（离开左缘 autoScroll 热区，滚动停止），落定到指针下的列
      const px = sLeft + 700
      await page.mouse.move(px, from.y, { steps: 10 })
      await sleep(350)
      leftColDate = await ev((x) => {
        const s = document.querySelector('.h-full.overflow-auto')
        const col = [...s.querySelectorAll('[data-date]')].find((c) => {
          const r = c.getBoundingClientRect()
          return x >= r.left && x < r.right
        })
        return col?.dataset.date ?? null
      }, px)
      ok(leftColDate, '找到落点列')
      await sleep(120)
    } finally {
      await page.mouse.up()
    }
    await waitFor(async () => (await cardColumnDate('E2E 卡 06')) === leftColDate, 6000, '落定到指针下列')
    ok(Math.abs(dayDiff(leftColDate, TODAY)) <= 30, `落点 ${leftColDate} 在窗口内`)
    await sleep(500)
  })

  await t('t14 删除卡片', async () => {
    await ev(() => {
      const el = [...document.querySelectorAll('.h-full.overflow-auto [data-card-title]')].find(
        (p) => p.textContent === 'E2E 卡 05',
      )
      el?.closest('.group')?.querySelector('button[aria-label="删除卡片"]')?.click()
    })
    await waitFor(async () => (await cardColumnDate('E2E 卡 05')) === null, 5000, '卡片从 DOM 移除')
  })

  await t('t15 同步推送：本地变更已整板 PUT 到服务端', async () => {
    await sleep(1500) // push=200 防抖 + 网络
    const r = await api('GET', `/boards/${boardId}`, undefined, token)
    eq(r.status, 200, 'GET 主板')
    const doc = r.body.doc
    const added = doc.items.find((i) => i.title === 'E2E 新增卡')
    ok(added, '服务端已有新卡')
    eq(added.publish_at, `${addDays(TODAY, 1)}T09:00`, '新卡改期已同步')
    ok(!doc.items.find((i) => i.id === 'e2e-c05'), '删除已同步')
    const c06 = doc.items.find((i) => i.id === 'e2e-c06')
    ok(c06 && Math.abs(dayDiff(c06.publish_at.slice(0, 10), TODAY)) <= 30, '边界拖拽落点已同步且在窗口内')
    const c04 = doc.items.find((i) => i.id === 'e2e-c04')
    eq(c04?.status, '已发布', '历史卡状态保留')
    ok(r.body.version >= 2, `version 已推进（v${r.body.version}）`)
  })

  await t('t16 外部 PUT 注入 → 页面轮询应用', async () => {
    const cur = await api('GET', `/boards/${boardId}`, undefined, token)
    const doc = cur.body.doc
    const ext = {
      id: 'ext-0001',
      title: '外部注入卡',
      type: '视频',
      publish_at: `${addDays(TODAY, 2)}T15:00`,
      roi: null,
      comment: '',
      product_id: 'P-1000',
      status: '待发布',
      content_owner_id: '',
      delivery_owner_id: '',
      propagation_4h: null,
      engagement_4h: null,
    }
    doc.items.push(ext)
    doc.orders['ext-0001'] = 99
    const put = await api('PUT', `/boards/${boardId}`, { doc }, token)
    eq(put.status, 200, '外部 PUT')
    await waitFor(async () => (await cardColumnDate('外部注入卡')) === addDays(TODAY, 2), 9000, '轮询应用到 UI')
  })

  let savedDoc = null // t17 前留档，t18 恢复用
  await t('t17 软上限：1500 张触发警示「还可添加 500 张」', async () => {
    const cur = await api('GET', `/boards/${boardId}`, undefined, token)
    savedDoc = cur.body.doc
    const need = 1500 - savedDoc.items.length
    ok(need > 0, `当前 ${savedDoc.items.length} 张，需填充 ${need} 张`)
    const ordersPatch = {}
    const fillers = fillerItems(need, 1, ordersPatch)
    const doc = { ...savedDoc, items: [...savedDoc.items, ...fillers], orders: { ...savedDoc.orders, ...ordersPatch } }
    const put = await api('PUT', `/boards/${boardId}`, { doc }, token)
    eq(put.status, 200, 'PUT 1500 张成功')
    await waitFor(
      () => ev(() => (document.querySelector('[data-capacity-hint]')?.textContent ?? '').includes('还可添加 500 张')),
      12000,
      '软上限警示出现',
    )
    await sleep(400)
    await page.screenshot({ path: path.join(VDIR, 'board-v16-soft-cap.png') })
  })

  await t('t18 硬上限：2000 禁用加卡/导入，PUT 2001 → 400，恢复后警示解除', async () => {
    const cur = await api('GET', `/boards/${boardId}`, undefined, token)
    const doc1500 = cur.body.doc
    eq(doc1500.items.length, 1500, '服务端已 1500 张')
    const orders2 = {}
    const more = fillerItems(2000 - doc1500.items.length, 5001, orders2)
    const doc2000 = { ...doc1500, items: [...doc1500.items, ...more], orders: { ...doc1500.orders, ...orders2 } }
    const put2000 = await api('PUT', `/boards/${boardId}`, { doc: doc2000 }, token)
    eq(put2000.status, 200, 'PUT 2000 张成功（上限含 2000）')
    await waitFor(
      () => ev(() => (document.querySelector('[data-capacity-hint]')?.textContent ?? '').includes('已达上限 2000 张')),
      12000,
      '硬上限警示出现',
    )
    const ui = await ev(() => {
      const topAdd = [...document.querySelectorAll('header button')].find((b) =>
        b.textContent.trim().startsWith('+ 空卡片'),
      )
      const imp = document.querySelector('[data-import-btn]')
      const col = document.querySelector('.h-full.overflow-auto [data-date]')
      const colAdd = [...col.querySelectorAll('button')].find((b) => b.textContent.includes('+ 空卡片'))
      return { topAdd: !!topAdd?.disabled, imp: !!imp?.disabled, colAdd: !!colAdd?.disabled }
    })
    ok(ui.topAdd && ui.imp && ui.colAdd, `加卡/导入均已禁用 ${JSON.stringify(ui)}`)
    // PUT 2001 → 400
    const orders3 = {}
    const one = fillerItems(1, 9001, orders3)
    const doc2001 = { ...doc2000, items: [...doc2000.items, ...one], orders: { ...doc2000.orders, ...orders3 } }
    const over = await api('PUT', `/boards/${boardId}`, { doc: doc2001 }, token)
    eq(over.status, 400, 'PUT 2001 被拒')
    ok(String(over.body?.error ?? '').includes('已达单板上限 2000 张'), `400 文案：${over.body?.error}`)
    // POST 建板 2001 → 400
    const post = await api('POST', '/boards', {
      name: '超限板',
      password: 'x',
      doc: { ...doc2001, meta: { name: '超限板', created_at: new Date().toISOString() } },
    })
    eq(post.status, 400, 'POST 2001 建板被拒')
    // 恢复现场
    const restore = await api('PUT', `/boards/${boardId}`, { doc: savedDoc }, token)
    eq(restore.status, 200, '恢复原 doc')
    await waitFor(() => ev(() => !document.querySelector('[data-capacity-hint]')), 12000, '容量警示解除')
  })

  await t('t19 首页删除看板（确认框 + 重输密码）', async () => {
    await page.goto(`${WEB}/`, { waitUntil: 'domcontentloaded' })
    await waitFor(() => ev(() => !!document.querySelector('[data-board-table]')), 8000, '看板列表加载')
    await ev((id) => {
      document.querySelector(`[data-board-row][data-board-id="${id}"] [data-board-delete]`)?.click()
    }, gateId)
    await waitFor(() => ev(() => !!document.querySelector('[data-delete-dialog]')), 5000, '删除确认框')
    await clearAndType('[data-delete-password]', GATE_PASS)
    await ev(() => document.querySelector('[data-delete-confirm]')?.click())
    await waitFor(() => ev(() => !document.querySelector('[data-delete-dialog]')), 6000, '删除完成')
    await waitFor(
      (id => () => ev((gid) => !document.querySelector(`[data-board-row][data-board-id="${gid}"]`), id))(gateId),
      6000,
      '列表移除',
    )
  })

  // ==================================================================
  // v15 旧套件移植（t20–t53）
  //   数据基础与旧套件同构：CLI 导入 examples/import-sample.json 写 public/data/board.json
  //   → 首页勾「从本机现有数据初始化」建数据板（9 卡/7 产品/3 成员）→ 交互用例跑在数据板上。
  //   v16 适配：计数断言按「窗口 [首列,末列] 内应渲染数」校验；用例间共享数据板状态（与旧套件一致）。
  // ==================================================================
  let guideId = null // t20 UI 建板捕获（引导卡 2 张）
  let dataId = null // t24 初始化建板捕获（示例 9 卡）
  let prodId = null // t40 产品板捕获（t53 删除对象）
  let editedDate = null // t25 编辑目标所在列
  let v6Title = null
  let v6FromDate = null
  let v6ToDate = null
  let v7Type = null
  const dataUrl = () => `${WEB}/b/${dataId}?poll=1000&push=200`

  await t('t20 首页建板直进（旧 v15CreateBoard；适配：库内已有主板，断言非空列表态）', async () => {
    await page.goto(`${WEB}/`, { waitUntil: 'domcontentloaded' })
    await waitFor(() => ev(() => !!document.querySelector('[data-home]')), 8000, '首页加载')
    await sleep(800) // loadLegacyLocal 异步（无 board.json → null）
    const home = await ev(() => ({
      rows: document.querySelectorAll('[data-board-row]').length,
      empty: !!document.querySelector('[data-list-empty]'),
      hint: document.querySelector('[data-legacy-hint]')?.textContent ?? '',
      initDisabled: document.querySelector('[data-create-init]')?.disabled ?? null,
    }))
    eq(home.rows, 1, '列表仅主板')
    ok(!home.empty, '非空库不显示空列表提示')
    ok(home.hint.includes('本机暂无可初始化数据'), '初始化提示：无本机数据')
    eq(home.initDisabled, true, '无本机数据时初始化勾选框禁用')

    await clearAndType('[data-create-name]', GUIDE_NAME)
    await clearAndType('[data-create-password]', GUIDE_PASS)
    await ev(() => document.querySelector('[data-create-btn]')?.click())
    await waitFor(() => ev(() => /\/b\/[0-9a-f]{16}/.test(window.location.pathname)), 10000, '建板后自动进板')
    guideId = await ev(() => /\/b\/([0-9a-f]{16})/.exec(window.location.pathname)?.[1] ?? null)
    ok(guideId, '捕获引导板 id')
    await waitFor(async () => (await colCount()) === 61, 9000, '引导板渲染 61 列')
    await waitFor(
      () => ev(() => document.querySelector('[data-sync-status]')?.dataset.syncStatus === 'synced'),
      10000,
      '同步点 synced',
    )
    const cards = await ev(() => document.querySelectorAll('.h-full.overflow-auto [data-card-title]').length)
    eq(cards, 2, '引导卡 2 张')
    eq(await ev(() => document.querySelector('[data-board-name]')?.textContent ?? null), GUIDE_NAME, '看板名 chip')
  })

  await t('t21 首次启动引导卡（旧 firstRunGuide）', async () => {
    const r = await ev((key) => {
      const resetBtn = [...document.querySelectorAll('button')].some((b) => b.textContent.includes('重置数据'))
      const scope = document.querySelector('.h-full.overflow-auto')
      const all = [...scope.querySelectorAll('[data-card-title]')]
      const todayCards = [...scope.querySelectorAll(`[data-date="${key}"] [data-card-title]`)]
      return { resetBtn, total: all.length, todayCount: todayCards.length, titles: todayCards.map((p) => p.textContent) }
    }, TODAY)
    ok(!r.resetBtn, '无「重置数据」按钮')
    eq(r.total, 2, '恰好 2 张卡')
    eq(r.todayCount, 2, '2 张都在今天列')
    eq(r.titles[0], GUIDE_TITLE_1, '引导卡 1 标题')
    eq(r.titles[1], GUIDE_TITLE_2, '引导卡 2 标题')
  })

  await t('t22 首次启动产品目录仅内置 P-1000（旧 v12FirstRunProducts）', async () => {
    await ev(() => document.querySelector('[data-products-btn]')?.click())
    await waitFor(() => ev(() => !!document.querySelector('[data-products-dialog]')), 5000, '产品弹窗')
    const r = await ev(() => {
      const rows = [...document.querySelectorAll('[data-products-dialog] [data-product-row]')]
      return {
        count: rows.length,
        firstId: rows[0]?.dataset.productId ?? null,
        firstName: rows[0]?.querySelector('[data-product-name]')?.textContent ?? null,
      }
    })
    await page.keyboard.press('Escape')
    await waitFor(() => ev(() => !document.querySelector('[data-products-dialog]')), 5000, '产品弹窗关闭')
    eq(r.count, 1, '仅 1 行')
    eq(r.firstId, 'P-1000', '内置产品 id')
    eq(r.firstName, '光轴', '内置产品名')
  })

  await t('t23 今天可见时 FAB 隐藏（旧 fabHiddenWhenTodayVisible）', async () => {
    ok(await dateVisible(TODAY), '今天列可见')
    const fab = await ev(() =>
      [...document.querySelectorAll('button')].some(
        (b) => b.textContent.includes('回到今天') && b.className.includes('rounded-full'),
      ),
    )
    ok(!fab, 'FAB 不出现')
  })

  await t('t24 CLI 导入 → 首页初始化建数据板（旧 importTakesOver）', async () => {
    execSync('npm run import:data -- examples/import-sample.json', { cwd: ROOT, stdio: 'pipe' })
    const { importedAt } = JSON.parse(readFileSync(BOARD_JSON, 'utf8'))
    await waitViteServes(importedAt)

    await page.goto(`${WEB}/`, { waitUntil: 'domcontentloaded' })
    await waitFor(
      () =>
        ev(() => {
          const h = document.querySelector('[data-legacy-hint]')?.textContent ?? ''
          return h.includes('9 张卡片') && h.includes('7 个产品') && h.includes('3 名成员')
        }),
      10000,
      '初始化提示 9 卡/7 产品/3 成员',
    )
    ok(await ev(() => document.querySelector('[data-create-init]')?.checked), '检测到本机数据时默认勾选')
    await clearAndType('[data-create-name]', DATA_NAME)
    await clearAndType('[data-create-password]', DATA_PASS)
    await ev(() => document.querySelector('[data-create-btn]')?.click())
    await waitFor(() => ev(() => /\/b\/[0-9a-f]{16}/.test(window.location.pathname)), 10000, '建板后自动进板')
    dataId = await ev(() => /\/b\/([0-9a-f]{16})/.exec(window.location.pathname)?.[1] ?? null)
    ok(dataId, '捕获数据板 id')

    await page.goto(dataUrl(), { waitUntil: 'domcontentloaded' })
    await waitFor(async () => (await colCount()) === 61, 9000, '数据板渲染 61 列')
    const doc = await waitFor(() => storedDoc(dataId), 9000, '缓存 doc 落盘')
    eq(doc.items.length, 9, '初始化合并 9 卡（数据层）')
    // v16 窗口断言：渲染数 = 窗口内应渲染数（样例全在窗口时即 9）
    const inWin = inWindowCount(doc, await firstDate(), await lastDate())
    eq(await renderedCount(), inWin, '窗口内卡片全渲染')
    ok(await cardColumnDate('星轨键盘 SE 开箱视频'), '锚点卡渲染（窗口覆盖 2026-08-05）')
    const membersOk =
      Array.isArray(doc.members) &&
      doc.members.length === 3 &&
      doc.members.some((m) => m.id === 'M-1001' && m.name === '林晓') &&
      doc.members.some((m) => m.id === 'M-1002' && m.name === '陈远') &&
      doc.members.some((m) => m.id === 'M-1003' && m.name === '苏晴')
    ok(membersOk, '成员合并（内置 2 + 苏晴 M-1003 自动登记）')
    eq(doc.products.length, 7, '产品合并（内置 P-1000 + 导入 5 + 自动登记 P-2100）')
  })

  await t('t25 详情标题 inline 编辑 Enter 保存（旧 inlineEdit）', async () => {
    editedDate = await cardColumnDate(EDIT_TARGET_TITLE)
    ok(editedDate, `找到编辑目标「${EDIT_TARGET_TITLE}」所在列`)
    await openCard(EDIT_TARGET_TITLE)
    await ev(() => document.querySelector('[data-detail-title]')?.click())
    await waitFor(() => ev(() => !!document.querySelector('input[placeholder="输入卡片标题…"]')), 4000, '标题输入框')
    await clearAndType('input[placeholder="输入卡片标题…"]', 'E2E 修改标题')
    await page.keyboard.press('Enter')
    await waitFor(
      () => ev(() => document.querySelector('[data-detail-title]')?.textContent === 'E2E 修改标题'),
      5000,
      '标题提交',
    )
    await closeDialog()
    const after = await ev(
      (d) => document.querySelector(`.h-full.overflow-auto [data-date="${d}"] [data-card-title]`)?.textContent ?? null,
      editedDate,
    )
    eq(after, 'E2E 修改标题', '列内标题更新')
  })

  await t('t26 标题编辑 Esc 只取消编辑、再 Esc 关弹窗（旧 inlineEditEscCancel）', async () => {
    ok(editedDate, '前置 t25 就绪')
    await openCard('E2E 修改标题')
    await ev(() => document.querySelector('[data-detail-title]')?.click())
    await waitFor(() => ev(() => !!document.querySelector('input[placeholder="输入卡片标题…"]')), 4000, '标题输入框')
    await page.keyboard.type('不应保存', { delay: 10 })
    await page.keyboard.press('Escape') // 只取消编辑
    await sleep(300)
    ok(await ev(() => !!document.querySelector('[data-slot="dialog-content"]')), '第一次 Esc 后弹窗仍在')
    ok(await ev(() => !document.querySelector('input[placeholder="输入卡片标题…"]')), '编辑态已退出')
    await closeDialog() // 第二次 Esc 关弹窗
    const after = await ev(
      (d) => document.querySelector(`.h-full.overflow-auto [data-date="${d}"] [data-card-title]`)?.textContent ?? null,
      editedDate,
    )
    eq(after, 'E2E 修改标题', '未保存取消内容')
  })

  await t('t27 数据板加卡直接进标题编辑（旧 addCardEntersEdit）', async () => {
    const before = await renderedCount()
    await ev((key) => {
      const col = document.querySelector(`.h-full.overflow-auto [data-date="${key}"]`)
      ;[...col.querySelectorAll('button')].find((b) => b.textContent.includes('+ 空卡片'))?.click()
    }, TODAY)
    await waitFor(
      () => ev(() => !!document.querySelector('[data-slot="dialog-content"] input[placeholder="输入卡片标题…"]')),
      5000,
      '新卡详情直接编辑标题',
    )
    eq(await renderedCount(), before + 1, '卡数 +1')
    await page.click('input[placeholder="输入卡片标题…"]')
    await page.keyboard.type('E2E 新卡片', { delay: 12 })
    await page.keyboard.press('Enter')
    await waitFor(
      () => ev(() => document.querySelector('[data-detail-title]')?.textContent === 'E2E 新卡片'),
      5000,
      '新卡标题提交',
    )
    await closeDialog()
    eq(await cardColumnDate('E2E 新卡片'), TODAY, '新卡落在今天列')
  })

  await t('t28 删除数据板卡片（旧 deleteCard）', async () => {
    const before = await renderedCount()
    await ev((t0) => {
      const el = [...document.querySelectorAll('.h-full.overflow-auto [data-card-title]')].find(
        (p) => p.textContent === t0,
      )
      el?.closest('.group')?.querySelector('button[aria-label="删除卡片"]')?.click()
    }, DELETE_TARGET_TITLE)
    await waitFor(async () => (await renderedCount()) === before - 1, 5000, '卡数 -1')
    eq(await cardColumnDate(DELETE_TARGET_TITLE), null, '目标卡已移除')
  })

  await t('t29 数据板跨日拖拽：今天 → 明天（旧 dragAcrossDays）', async () => {
    const tomorrow = addDays(TODAY, 1)
    const counts = () =>
      ev(({ key, tm }) => ({
        today: document.querySelectorAll(`.h-full.overflow-auto [data-date="${key}"] [data-card-title]`).length,
        next: document.querySelectorAll(`.h-full.overflow-auto [data-date="${tm}"] [data-card-title]`).length,
      }), { key: TODAY, tm: tomorrow })
    const before = await counts()
    const from = await ev((key) => {
      const col = document.querySelector(`.h-full.overflow-auto [data-date="${key}"]`)
      const el = [...col.querySelectorAll('[data-card-title]')].find((p) => p.textContent === 'E2E 新卡片')
      if (!el) return null
      const r = el.closest('.group').getBoundingClientRect()
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
    }, TODAY)
    ok(from, '今天列找到「E2E 新卡片」')
    const to = await ev((d) => {
      const r = document.querySelector(`.h-full.overflow-auto [data-date="${d}"]`).getBoundingClientRect()
      return { x: r.left + 118, y: Math.min(r.top + 320, 800) }
    }, tomorrow)
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    try {
      await page.mouse.move(from.x + 30, from.y + 6, { steps: 5 })
      await sleep(80)
      await page.mouse.move(to.x, to.y, { steps: 12 })
      await sleep(280)
    } finally {
      await page.mouse.up()
    }
    await waitFor(async () => (await cardColumnDate('E2E 新卡片')) === tomorrow, 6000, '落定明天列')
    const after = await counts()
    eq(after.today, before.today - 1, '今天列 -1')
    eq(after.next, before.next + 1, '明天列 +1')
    await sleep(500) // 等 click 抑制解除
  })

  // ------------------------------------------------------------------
  // 详情字段链路（旧 v6/v7/v10）：共享同一张已发布卡 imp-0001，弹窗跨用例保持打开
  // ------------------------------------------------------------------
  await t('t30 已发布卡详情指标格可编辑（旧 v6OpenPublishedCard）', async () => {
    v6Title = '星轨键盘 SE 开箱视频' // imp-0001：样例中首张历史已发布卡（旧 v6-0 的确定性发现结果）
    v6FromDate = await cardColumnDate(v6Title)
    ok(v6FromDate && v6FromDate < TODAY, `锚点卡在过去列（${v6FromDate}）`)
    await openCard(v6Title)
    ok(
      await ev(() => !!document.querySelector('[data-slot="dialog-content"] [data-edit-field="roi"]')),
      'ROI 指标格可编辑',
    )
  })

  await t('t31 编辑 ROI/曝光/互动（旧 v6EditMetrics）', async () => {
    ok(v6Title, '前置 t30 就绪')
    await editNum('roi', '4.2')
    await editNum('propagation_4h', '12345')
    await editNum('engagement_4h', '1000')
    const txt = await ev(() => document.querySelector('[data-slot="dialog-content"]')?.textContent ?? '')
    ok(txt.includes('×4.2') && txt.includes('12.3k') && txt.includes('1k'), '弹窗格式化文案 ×4.2 / 12.3k / 1k')
  })

  await t('t32 互动率反推互动量（旧 v6EditRate）', async () => {
    ok(v6Title, '前置 t30 就绪')
    await editNum('rate', '10') // 12345 × 10% → 1235
    const it = await waitFor(async () => {
      const i = await storedItem(dataId, v6Title)
      return i && i.engagement_4h === 1235 ? i : null
    }, 5000, 'rate 反推落库')
    eq(it.propagation_4h, 12345, '曝光保持 12345')
    const txt = await ev(() => document.querySelector('[data-slot="dialog-content"]')?.textContent ?? '')
    ok(txt.includes('1.2k'), '互动量格式化 1.2k')
  })

  await t('t33 非法输入红边抖动不落库（旧 v6InvalidInput）', async () => {
    ok(v6Title, '前置 t30 就绪')
    await ev(() => document.querySelector('[data-edit-field="roi"]')?.click())
    await waitFor(() => ev(() => !!document.querySelector('[data-edit-input="roi"]')), 4000, 'roi 输入框')
    // number 输入框拒收字母键：native setter 置空 + input 事件让 draft 真实变 ''（空 = 非法）
    await ev(() => {
      const el = document.querySelector('[data-edit-input="roi"]')
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
      setter.call(el, '')
      el.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await sleep(150)
    await page.keyboard.press('Enter')
    await sleep(300)
    const cls = await ev(() => document.querySelector('[data-edit-input="roi"]')?.className ?? '')
    ok(cls.includes('animate-shake'), `红边抖动（class=${cls.slice(0, 80)}）`)
    eq((await storedItem(dataId, v6Title))?.roi, 4.2, '非法输入不落库')
    await page.keyboard.press('Escape') // 只退编辑态，不关弹窗
    await sleep(250)
    ok(await ev(() => !!document.querySelector('[data-slot="dialog-content"]')), 'Esc 后弹窗仍在')
    ok(await ev(() => !document.querySelector('[data-edit-input="roi"]')), '已退出编辑态')
  })

  await t('t34 详情切换归属产品（旧 v6EditProduct）', async () => {
    ok(v6Title, '前置 t30 就绪')
    await ev(() => document.querySelector('[data-edit-field="product_id"]')?.click())
    await waitFor(() => ev(() => !!document.querySelector('[data-edit-input="product_id"]')), 4000, '产品选择器')
    await page.select('[data-edit-input="product_id"]', 'P-2004')
    await sleep(300)
    const txt = await ev(() => document.querySelector('[data-slot="dialog-content"]')?.textContent ?? '')
    ok(txt.includes('磐石移动电源'), '显示「磐石移动电源 20000mAh」')
  })

  await t('t35 详情改 publish_at 移列（旧 v6EditPublishAt；t10/t11 之外保留链路状态）', async () => {
    ok(v6Title && v6FromDate, '前置 t30 就绪')
    v6ToDate = addDays(TODAY, -2)
    if (v6ToDate === v6FromDate) v6ToDate = addDays(TODAY, -3)
    const beforeCount = await ev(
      (d) => document.querySelectorAll(`.h-full.overflow-auto [data-date="${d}"] [data-card-title]`).length,
      v6FromDate,
    )
    await editPublishAt(`${v6ToDate}T10:00`)
    await waitFor(async () => (await cardColumnDate(v6Title)) === v6ToDate, 6000, '卡片移列')
    const fromCount = await ev(
      (d) => document.querySelectorAll(`.h-full.overflow-auto [data-date="${d}"] [data-card-title]`).length,
      v6FromDate,
    )
    eq(fromCount, beforeCount - 1, '原列计数 -1')
    await closeDialog()
  })

  await t('t36 类型胶囊切换三处同步（旧 v7EditType）', async () => {
    ok(v6Title && v6ToDate, '前置 t35 就绪')
    await openCard(v6Title)
    const before = (await ev(() => document.querySelector('[data-type-trigger]')?.textContent ?? '')).trim()
    v7Type = before === '直播' ? '图文' : '直播'
    await ev(() => document.querySelector('[data-type-trigger]')?.click())
    await waitFor(() => ev(() => document.querySelectorAll('[data-type-option]').length === 5), 4000, '5 个类型选项')
    await page.keyboard.press('Escape') // 只关选择器
    await sleep(250)
    const afterEsc = await ev(() => ({
      picker: !!document.querySelector('[data-type-option]'),
      dialog: !!document.querySelector('[data-slot="dialog-content"]'),
    }))
    ok(!afterEsc.picker && afterEsc.dialog, 'Esc 只关选择器不关弹窗')
    await ev(() => document.querySelector('[data-type-trigger]')?.click())
    await waitFor(() => ev(() => !!document.querySelector('[data-type-option]')), 4000, '重新展开选择器')
    await ev((t0) => document.querySelector(`[data-type-option="${t0}"]`)?.click(), v7Type)
    await sleep(400)
    const after = await ev((t0) => {
      const dlg = document.querySelector('[data-slot="dialog-content"]')
      const el = [...document.querySelectorAll('.h-full.overflow-auto [data-card-title]')].find(
        (p) => p.textContent === t0,
      )
      return {
        head: dlg?.querySelector('[data-type-trigger]')?.textContent ?? '',
        pickerGone: !dlg?.querySelector('[data-type-option]'),
        cardType: el?.closest('.group')?.querySelector('[data-card-type]')?.textContent ?? null,
      }
    }, v6Title)
    const storedType = (await storedItem(dataId, v6Title))?.type
    await closeDialog()
    ok(after.head.includes(v7Type) && after.pickerGone, '弹窗头部同步且选择器已收')
    eq(after.cardType, v7Type, '卡面胶囊同步')
    eq(storedType, v7Type, '缓存 doc 同步')
  })

  await t('t37 长备注 1500+ 字：保存/滚动/重开完整（旧 v10LongCommentScroll）', async () => {
    ok(v6Title && v6ToDate, '前置 t35 就绪')
    const para =
      '复盘记录：本次内容投放节奏符合预期，首小时曝光爬坡较快，评论区高频问题集中在售价与配色两个点；后续跟进需要在详情页补充尺寸对照表，并安排一场直播集中答疑，同时把用户晒单整理成二次传播素材。'
    let LONG = ''
    for (let i = 1; LONG.length < 1600; i++) LONG += (LONG ? '\n\n' : '') + `第${i}段　${para}`
    await openCard(v6Title)
    await ev(() => document.querySelector('[data-edit-field="comment"]')?.click())
    await waitFor(() => ev(() => !!document.querySelector('[data-edit-input="comment"]')), 4000, '备注输入框')
    await ev((val) => {
      const el = document.querySelector('[data-edit-input="comment"]')
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
      setter.call(el, val)
      el.dispatchEvent(new Event('input', { bubbles: true }))
    }, LONG)
    await sleep(150)
    await page.keyboard.press('Enter') // Enter（无 Shift）= 保存
    await sleep(400)
    const it = await storedItem(dataId, v6Title)
    ok(it && it.comment === LONG, `缓存 doc 完整保存（${LONG.length} 字）`)
    const dims = await ev(() => {
      const s = document.querySelector('[data-detail-scroll]')
      return s ? { sh: s.scrollHeight, ch: s.clientHeight } : null
    })
    ok(dims && dims.sh > dims.ch, '内容区溢出可滚')
    await ev(() => {
      const s = document.querySelector('[data-detail-scroll]')
      s.style.scrollBehavior = 'auto'
      s.scrollTop = s.scrollHeight
    })
    await sleep(300)
    const vis = await ev(() => {
      const b = document.querySelector('[data-detail-delete]')
      if (!b) return { found: false }
      const r = b.getBoundingClientRect()
      return { found: true, scrolled: document.querySelector('[data-detail-scroll]').scrollTop > 0, top: r.top, bottom: r.bottom, vh: window.innerHeight }
    })
    ok(vis.found && vis.scrolled && vis.top >= 0 && vis.bottom <= vis.vh, '滚到底部删除按钮仍在视口')
    await page.screenshot({ path: path.join(VDIR, 'board-v10-dialog-scroll.png') })
    await closeDialog()
    await openCard(v6Title) // 重开完整渲染
    const rendered = await ev(
      () => document.querySelector('[data-slot="dialog-content"] [data-edit-field="comment"]')?.textContent ?? null,
    )
    await closeDialog()
    ok(rendered === LONG, `重开渲染完整（${rendered?.length} 字）`)
  })

  await t('t38 持久化：reload 后全部改动保持（旧 persistence；t15 之外的 DOM 层核验）', async () => {
    ok(editedDate && v6Title && v6ToDate && v7Type, '前置链路就绪')
    await page.reload({ waitUntil: 'domcontentloaded' })
    await waitFor(async () => (await colCount()) === 61, 9000, '重载渲染 61 列')
    await waitFor(
      () => ev(() => document.querySelector('[data-sync-status]')?.dataset.syncStatus === 'synced'),
      10000,
      '重载后 synced',
    )
    await sleep(800)
    const r = await ev(
      ({ edited, editedDate, added, tomorrow, deleted, vt, vd, v7t }) => {
        const scope = document.querySelector('.h-full.overflow-auto')
        const inCol = (d, t0) => {
          const col = scope.querySelector(`[data-date="${d}"]`)
          return col ? [...col.querySelectorAll('[data-card-title]')].some((p) => p.textContent === t0) : false
        }
        const v6el = [...scope.querySelectorAll('[data-card-title]')].find((p) => p.textContent === vt)
        const v6txt = v6el?.closest('.group')?.textContent ?? ''
        return {
          total: scope.querySelectorAll('[data-card-title]').length,
          edited: inCol(editedDate, edited),
          addedInTomorrow: inCol(tomorrow, added),
          deletedGone: ![...scope.querySelectorAll('[data-card-title]')].some((p) => p.textContent === deleted),
          v6inCol: inCol(vd, vt),
          v6roi: v6txt.includes('×4.2'),
          v6eng: v6txt.includes('1.2k'),
          v7type: v6el?.closest('.group')?.querySelector('[data-card-type]')?.textContent === v7t,
        }
      },
      { edited: 'E2E 修改标题', editedDate, added: 'E2E 新卡片', tomorrow: addDays(TODAY, 1), deleted: DELETE_TARGET_TITLE, vt: v6Title, vd: v6ToDate, v7t: v7Type },
    )
    const doc = await storedDoc(dataId)
    eq(doc?.items?.length, 9, '数据层 9 张（导入 9 - 删 1 + 加 1）')
    eq(r.total, inWindowCount(doc, await firstDate(), await lastDate()), '渲染数 = 窗口内应渲染数')
    ok(r.edited && r.addedInTomorrow && r.deletedGone, '改题/新增/删除保持')
    ok(r.v6inCol && r.v6roi && r.v6eng && r.v7type, '字段链路改动保持（移列/ROI/互动/类型）')
  })

  await t('t39 产品管理增删改 + 引用降级「不明」（旧 v12ProductManager）', async () => {
    ok(v6Title && v6ToDate, '前置链路就绪')
    await ev(() => document.querySelector('[data-products-btn]')?.click())
    await waitFor(() => ev(() => !!document.querySelector('[data-products-dialog]')), 5000, '产品弹窗')
    const before = await ev(() => {
      const rows = [...document.querySelectorAll('[data-products-dialog] [data-product-row]')]
      const r2002 = rows.find((x) => x.dataset.productId === 'P-2002')
      return { count: rows.length, usage2002: r2002?.querySelector('[data-product-usage]')?.textContent ?? null }
    })
    eq(before.count, 7, '初始化合并目录 7 行')
    eq(before.usage2002, '2 张', 'P-2002 引用计数')

    await page.click('[data-product-add-input]')
    await page.keyboard.type('测试产品甲', { delay: 10 })
    await ev(() => document.querySelector('[data-product-add]')?.click())
    await waitFor(
      () => ev(() => document.querySelectorAll('[data-products-dialog] [data-product-row]').length === 8),
      5000,
      '新增后 8 行',
    )
    const added = await ev(() => {
      const rows = [...document.querySelectorAll('[data-products-dialog] [data-product-row]')]
      const last = rows[rows.length - 1]
      return { id: last?.dataset.productId ?? null, name: last?.querySelector('[data-product-name]')?.textContent ?? null }
    })
    eq(added.id, 'P-2101', '自动 id = max+1')
    eq(added.name, '测试产品甲', '新增名称')

    await page.click('[data-product-row][data-product-id="P-2101"] [data-product-name]')
    await waitFor(() => ev(() => !!document.querySelector('[data-product-name-input]')), 4000, '名称编辑态')
    await page.keyboard.type('测试产品甲改', { delay: 10 }) // 编辑态全选，直接输入替换
    await page.keyboard.press('Enter')
    await waitFor(
      () =>
        ev(
          () =>
            document.querySelector('[data-product-row][data-product-id="P-2101"] [data-product-name]')?.textContent ===
            '测试产品甲改',
        ),
      5000,
      '改名生效',
    )
    await waitFor(async () => (await storedDoc(dataId))?.products?.length === 8, 5000, 'products 落库 8 个')
    await page.screenshot({ path: path.join(VDIR, 'board-v12-products.png') })
    await page.keyboard.press('Escape')
    await waitFor(() => ev(() => !document.querySelector('[data-products-dialog]')), 5000, '产品弹窗关闭')

    // 详情选择器实时出现新产品
    await openCard(v6Title)
    await ev(() => document.querySelector('[data-edit-field="product_id"]')?.click())
    await waitFor(() => ev(() => !!document.querySelector('[data-edit-input="product_id"]')), 4000, '产品选择器')
    const hasNew = await ev(() =>
      [...document.querySelectorAll('[data-edit-input="product_id"] option')].some(
        (o) => o.value === 'P-2101' && o.textContent.includes('测试产品甲改'),
      ),
    )
    await page.keyboard.press('Escape') // 取消字段编辑
    await sleep(250)
    await closeDialog()
    ok(hasNew, '选择器出现 P-2101 测试产品甲改')

    // 删除被引用的 P-2002 → 引用卡降级「不明」→ reload 保持
    await ev(() => document.querySelector('[data-products-btn]')?.click())
    await waitFor(() => ev(() => !!document.querySelector('[data-products-dialog]')), 5000, '产品弹窗再开')
    await ev(() => document.querySelector('[data-product-row][data-product-id="P-2002"] [data-product-delete]')?.click())
    await waitFor(
      () => ev(() => document.querySelectorAll('[data-products-dialog] [data-product-row]').length === 7),
      5000,
      '删除后 7 行',
    )
    await page.keyboard.press('Escape')
    await waitFor(() => ev(() => !document.querySelector('[data-products-dialog]')), 5000, '产品弹窗关闭')
    const face = await cardFaceProduct('耳机降噪地铁实测')
    eq(face?.text, '不明', '引用卡降级「不明」')
    await page.reload({ waitUntil: 'domcontentloaded' })
    await waitFor(async () => (await colCount()) === 61, 9000, '重载渲染')
    await sleep(1000)
    const keptDoc = await storedDoc(dataId)
    eq(keptDoc?.products?.length, 7, 'reload 后目录 7 个')
    eq((await cardFaceProduct('耳机降噪地铁实测'))?.text, '不明', 'reload 后保持「不明」')
  })

  await t('t40 产品独立导入接管 + 初始化建产品板（旧 v11ProductsOnlyTakeover）', async () => {
    execSync('npm run import:data -- --products examples/products-sample.json', { cwd: ROOT, stdio: 'pipe' })
    const { importedAt } = JSON.parse(readFileSync(BOARD_JSON, 'utf8'))
    await waitViteServes(importedAt)
    // CLI 层：累积 9 个、无 items 键、同 id 改名 / 新 id 追加 / 未提及保留
    const j = JSON.parse(readFileSync(BOARD_JSON, 'utf8'))
    ok(!('items' in j), 'board.json 无 items 键')
    eq(j.products?.length, 9, '累积目录 9 个')
    ok(j.products.some((p) => p.id === 'P-2001' && p.name === '极光机械键盘 Pro Max'), 'P-2001 同 id 改名')
    ok(j.products.some((p) => p.id === 'P-2003' && p.name === '星云智能台灯 · 二代'), 'P-2003 同 id 改名')
    ok(j.products.some((p) => p.id === 'P-2006' && p.name === '雨林木匠人体工学椅'), '新 id 追加')
    ok(j.products.some((p) => p.id === 'P-2002' && p.name === '深海降噪耳机'), '未提及保留')

    // UI 层：初始化建产品板（board.json 无 items → 引导卡 2 张；目录 内置 1 + 9 = 10；成员内置 2）
    await page.goto(`${WEB}/`, { waitUntil: 'domcontentloaded' })
    await waitFor(
      () =>
        ev(() => {
          const h = document.querySelector('[data-legacy-hint]')?.textContent ?? ''
          return h.includes('2 张卡片') && h.includes('10 个产品') && h.includes('2 名成员')
        }),
      10000,
      '产品板初始化提示 2 卡/10 产品/2 成员',
    )
    await clearAndType('[data-create-name]', PROD_NAME)
    await clearAndType('[data-create-password]', PROD_PASS)
    await ev(() => document.querySelector('[data-create-btn]')?.click())
    await waitFor(() => ev(() => /\/b\/[0-9a-f]{16}/.test(window.location.pathname)), 10000, '建产品板进板')
    prodId = await ev(() => /\/b\/([0-9a-f]{16})/.exec(window.location.pathname)?.[1] ?? null)
    ok(prodId, '捕获产品板 id')
    await waitFor(async () => (await colCount()) === 61, 9000, '产品板渲染 61 列')
    await sleep(600)

    await openCard(GUIDE_TITLE_1)
    await ev(() => document.querySelector('[data-edit-field="product_id"]')?.click())
    await waitFor(() => ev(() => !!document.querySelector('[data-edit-input="product_id"]')), 4000, '产品选择器')
    const opts = await ev(() =>
      [...document.querySelectorAll('[data-edit-input="product_id"] option')].map((o) => ({ value: o.value, text: o.textContent })),
    )
    await page.keyboard.press('Escape') // 只取消字段编辑
    await sleep(250)
    await closeDialog()
    ok(opts[0] && opts[0].value === '' && opts[0].text.includes('不明'), '首项「不明（不归属）」')
    eq(opts.length, 11, '不明 + 10 个产品')
    ok(opts.some((o) => o.value === 'P-1000'), '内置保留')
    ok(opts.some((o) => o.value === 'P-2006'), 'CLI 新 id 在选择器')
    ok(opts.some((o) => o.value === 'P-2001' && o.text.includes('极光机械键盘 Pro Max')), '改名在选择器')
    ok(opts.some((o) => o.value === 'P-2002' && o.text.includes('深海降噪耳机')), '未提及在选择器')

    // 回数据板继续后续用例
    await page.goto(dataUrl(), { waitUntil: 'domcontentloaded' })
    await waitFor(async () => (await colCount()) === 61, 9000, '回数据板')
    await sleep(1000)
  })

  await t('t41 未知 product_id 降级「不明」全链路（旧 v11UnknownProduct）', async () => {
    ok(dataId && v6Title, '前置链路就绪')
    const auth2 = await api('POST', `/boards/${dataId}/auth`, { password: DATA_PASS })
    eq(auth2.status, 200, '数据板 auth')
    const token2 = auth2.body.token
    const doc2 = (await api('GET', `/boards/${dataId}`, undefined, token2)).body.doc
    const target = doc2.items.find((i) => i.title === v6Title)
    ok(target, '服务端 doc 找到锚点卡')
    target.product_id = 'P-9999'
    const put = await api('PUT', `/boards/${dataId}`, { doc: doc2 }, token2)
    eq(put.status, 200, '注入 P-9999')
    await waitFor(async () => (await cardFaceProduct(v6Title))?.text === '不明', 9000, '轮询应用「不明」')
    const faceA = await cardFaceProduct(v6Title)
    eq(faceA?.title, '原始 product_id: P-9999', 'tooltip 保留原始 id')
    await page.screenshot({ path: path.join(VDIR, 'board-v11-unknown-product.png') })

    await openCard(v6Title)
    await ev(() => document.querySelector('[data-edit-field="product_id"]')?.click())
    await waitFor(() => ev(() => !!document.querySelector('[data-edit-input="product_id"]')), 4000, '产品选择器')
    const selState = await ev(() => {
      const s = document.querySelector('[data-edit-input="product_id"]')
      return s ? { value: s.value, title: s.getAttribute('title') } : null
    })
    ok(selState && selState.value === '' && selState.title === '原始 product_id: P-9999', '选择器停在「不明」项')
    await page.select('[data-edit-input="product_id"]', '') // 选「不明（不归属）」= 清空归属
    await sleep(300)
    ok(await ev(() => !!document.querySelector('[data-slot="dialog-content"] [data-detail-product-unknown]')), '弹窗内「不明」标记')
    await closeDialog()
    const faceB = await cardFaceProduct(v6Title)
    ok(faceB && faceB.text === '不明' && faceB.title === null, '清空后卡面「不明」且无 tooltip')
    eq((await storedItem(dataId, v6Title))?.product_id, '', '落库空 product_id')
    await page.reload({ waitUntil: 'domcontentloaded' })
    await waitFor(async () => (await colCount()) === 61, 9000, '重载渲染')
    await sleep(1000)
    eq((await cardFaceProduct(v6Title))?.text, '不明', 'reload 保持「不明」')
  })

  await t('t42 UI 导入报告 + 幂等再导（旧 v12UiImport）', async () => {
    const tmp = path.join(VDIR, 'tmp-v12-ui-import.json')
    writeFileSync(tmp, JSON.stringify({ items: [
      { id: 'ui-0001', type: '图文', title: 'UI导入图文', product_id: 'P-2003', status: '已发布', publish_at: '2026-08-25T10:00', metrics: { views: 1, likes: 2, comments: 3, favorites: 4, shares: 5, follows: 6, conversions: 7 } },
      { id: 'ui-0002', type: '视频', title: 'UI导入无产品', product_id: '', status: '待发布', publish_at: '2026-08-26T11:00' },
      { id: 'ui-0003', type: '图文', title: '', product_id: 'P-2003', status: '已发布', publish_at: '2026-08-25T10:00' },
    ] }))
    try {
      const reportOf = () =>
        ev(() => ({
          imported: document.querySelector('[data-report-imported]')?.textContent ?? null,
          skipped: document.querySelector('[data-report-skipped]')?.textContent ?? null,
          unpublished: document.querySelector('[data-report-unpublished]')?.textContent ?? null,
          noproduct: document.querySelector('[data-report-noproduct]')?.textContent ?? null,
          skipRows: document.querySelectorAll('[data-report-skip-row]').length,
        }))
      await (await page.$('[data-import-input]')).uploadFile(tmp)
      await waitFor(() => ev(() => !!document.querySelector('[data-report-imported]')), 6000, '导入报告出现')
      const report = await reportOf()
      eq(report.imported, '2', '导入 2 条')
      eq(report.skipped, '1', '跳过 1 条（空标题）')
      eq(report.unpublished, '1', '未发布 1 条（显式待发布）')
      eq(report.noproduct, '1', '未填归属 1 条')
      eq(report.skipRows, 1, '跳过明细 1 行')
      await page.screenshot({ path: path.join(VDIR, 'board-v12-import-result.png') })
      await page.keyboard.press('Escape')
      await waitFor(() => ev(() => !document.querySelector('[data-report-imported]')), 5000, '报告关闭')
      await waitFor(async () => (await storedDoc(dataId))?.items?.length === 11, 5000, '落库 11 张')
      const doc11 = await storedDoc(dataId)
      eq(await renderedCount(), inWindowCount(doc11, await firstDate(), await lastDate()), '渲染数 = 窗口内 11')

      await (await page.$('[data-import-input]')).uploadFile(tmp) // 幂等再导
      await waitFor(() => ev(() => !!document.querySelector('[data-report-imported]')), 6000, '再导报告')
      eq((await reportOf()).imported, '2', '再导报告仍 2（同 id 合并）')
      await page.keyboard.press('Escape')
      await waitFor(() => ev(() => !document.querySelector('[data-report-imported]')), 5000, '报告关闭')
      await waitFor(async () => (await storedDoc(dataId))?.items?.length === 11, 5000, '再导不翻倍')
    } finally {
      rmSync(tmp, { force: true })
    }
  })

  await t('t43 产品目录差分 + 未知 id 自动登记（旧 v13DifferentialImport）', async () => {
    const tmp = path.join(VDIR, 'tmp-v13-diff-import.json')
    writeFileSync(tmp, JSON.stringify({
      products: [{ id: 'P-2004', name: '磐石移动电源 30000mAh' }],
      items: [
        { id: 'ui-1001', type: '图文', title: 'v13自动登记演示', publish_at: '2026-08-27T10:00', product_id: 'P-3100', product_name: '幻影 mini 主机', roi: 1.5, propagation_4h: 100, engagement_4h: 10 },
        { id: 'ui-1002', type: '视频', title: 'v13占位名演示', publish_at: '2026-08-27T12:00', product_id: 'P-3200' },
      ],
    }))
    try {
      await (await page.$('[data-import-input]')).uploadFile(tmp)
      await waitFor(() => ev(() => !!document.querySelector('[data-report-imported]')), 6000, '差分报告出现')
      const rep = await ev(() => ({
        imported: document.querySelector('[data-report-imported]')?.textContent ?? null,
        skipped: document.querySelector('[data-report-skipped]')?.textContent ?? null,
        noproduct: document.querySelector('[data-report-noproduct]')?.textContent ?? null,
        registered: document.querySelector('[data-report-registered]')?.textContent ?? null,
        added: document.querySelector('[data-report-pdiff-added]')?.textContent ?? null,
        updated: document.querySelector('[data-report-pdiff-updated]')?.textContent ?? null,
        kept: document.querySelector('[data-report-pdiff-kept]')?.textContent ?? null,
      }))
      eq(rep.imported, '2', '导入 2 条')
      eq(rep.skipped, '0', '跳过 0')
      eq(rep.noproduct, '0', '未填归属 0（自动登记不算未填）')
      ok(rep.registered?.includes('自动登记新产品 2 个'), `自动登记 2 个（${rep.registered}）`)
      eq(rep.added, '2', '差分新增 2')
      eq(rep.updated, '1', '差分更新 1（P-2004 改名）')
      eq(rep.kept, '0', '差分保留 0')
      await page.screenshot({ path: path.join(VDIR, 'board-v13-import-diff.png') })
      await page.keyboard.press('Escape')
      await waitFor(() => ev(() => !document.querySelector('[data-report-imported]')), 5000, '报告关闭')

      eq((await cardFaceProduct('v13自动登记演示'))?.text, '幻影 mini 主机', '随行名称直接显示')
      eq((await cardFaceProduct('v13占位名演示'))?.text, 'P-3200', '缺名以 id 占位')
      await waitFor(async () => (await storedDoc(dataId))?.products?.length === 9, 5000, '目录落库 9 个')
      const storedP = (await storedDoc(dataId)).products
      ok(storedP.find((p) => p.id === 'P-3100')?.name === '幻影 mini 主机', 'P-3100 登记名')
      ok(storedP.find((p) => p.id === 'P-2004')?.name === '磐石移动电源 30000mAh', 'P-2004 改名落库')
      ok(storedP.some((p) => p.id === 'P-2101'), '既有新增保留')
      const doc13 = await storedDoc(dataId)
      eq(doc13.items.length, 13, '数据层 13 张')
      eq(await renderedCount(), inWindowCount(doc13, await firstDate(), await lastDate()), '渲染数 = 窗口内 13')

      await (await page.$('[data-import-input]')).uploadFile(tmp) // 幂等再导
      await waitFor(() => ev(() => !!document.querySelector('[data-report-imported]')), 6000, '再导报告')
      const rep2 = await ev(() => ({
        registered: !!document.querySelector('[data-report-registered]'),
        added: document.querySelector('[data-report-pdiff-added]')?.textContent ?? null,
        updated: document.querySelector('[data-report-pdiff-updated]')?.textContent ?? null,
        kept: document.querySelector('[data-report-pdiff-kept]')?.textContent ?? null,
      }))
      ok(!rep2.registered, '再导无自动登记行')
      ok(rep2.added === '0' && rep2.updated === '0' && rep2.kept === '1', `再导差分 0/0/1（${JSON.stringify(rep2)}）`)
      await page.keyboard.press('Escape')
      await waitFor(() => ev(() => !document.querySelector('[data-report-imported]')), 5000, '报告关闭')
      await sleep(300)
      eq((await storedDoc(dataId))?.items?.length, 13, '再导卡片不翻倍')
    } finally {
      rmSync(tmp, { force: true })
    }
  })

  await t('t44 状态联动 + 旧档字段剥离迁移（旧 v14StatusMetrics）', async () => {
    ok(dataId && v6Title && v6ToDate, '前置链路就绪')
    await sleep(1200) // 等前面的推送沉降，避免与服务端 PUT 互相覆盖
    const auth2 = await api('POST', `/boards/${dataId}/auth`, { password: DATA_PASS })
    const token2 = auth2.body.token
    const doc2 = (await api('GET', `/boards/${dataId}`, undefined, token2)).body.doc
    for (const it of doc2.items) {
      delete it.status
      delete it.content_owner_id
      delete it.delivery_owner_id
    }
    const marker = doc2.items.find((i) => i.title === '耳机降噪地铁实测')
    ok(marker, '服务端 doc 找到标记卡')
    marker.comment = `${marker.comment ?? ''} __v14_marker__`
    const put = await api('PUT', `/boards/${dataId}`, { doc: doc2 }, token2)
    eq(put.status, 200, '字段剥离 PUT')
    await waitFor(
      () =>
        ev(
          (k, t0) =>
            JSON.parse(localStorage.getItem(k) ?? 'null')
              ?.items?.find((i) => i.title === t0)
              ?.comment?.includes('__v14_marker__') === true,
          `timeline-board-v4:b:${dataId}`,
          '耳机降噪地铁实测',
        ),
      9000,
      '轮询应用字段剥离（缓存出现标记）',
    )
    await sleep(300)

    // A. 旧档迁移：锚点卡（已移到 today-2，过去）→ 推导已发布 + 指标可编辑 + 迁移落库
    await openCard(v6Title)
    const mig = await ev(() => {
      const dlg = document.querySelector('[data-slot="dialog-content"]')
      return {
        badge: dlg?.querySelector('[data-status-badge]')?.textContent?.trim() ?? null,
        roiEditable: !!dlg?.querySelector('[data-edit-field="roi"]'),
      }
    })
    const migStored = (await storedItem(dataId, v6Title))?.status
    await closeDialog()
    eq(mig.badge, '已发布', '迁移推导已发布徽章')
    ok(mig.roiEditable, '迁移后指标可编辑')
    eq(migStored, '已发布', '迁移落库 status=已发布')

    // B. 状态联动：imp-0007（2026-09-10 未来 → 推导待发布，指标锁定占位）
    await openCard('数据线快充横评')
    const before = await ev(() => {
      const dlg = document.querySelector('[data-slot="dialog-content"]')
      return {
        badge: dlg?.querySelector('[data-status-badge]')?.textContent?.trim() ?? null,
        roiLocked: !dlg?.querySelector('[data-edit-field="roi"]'),
        placeholder: dlg?.textContent.includes('指标锁定') ?? false,
      }
    })
    eq(before.badge, '待发布', '未来卡推导待发布')
    ok(before.roiLocked && before.placeholder, '指标锁定占位')
    await ev(() => document.querySelector('[data-status-option="已发布"]')?.click())
    await waitFor(() => ev(() => !!document.querySelector('[data-edit-field="roi"]')), 4000, '切已发布解锁指标')
    await editNum('roi', '3.3')
    const it7a = await waitFor(async () => {
      const i = await storedItem(dataId, '数据线快充横评')
      return i && i.roi === 3.3 ? i : null
    }, 5000, 'ROI 3.3 落库')
    eq(it7a.status, '已发布', '状态落库已发布')
    await ev(() => document.querySelector('[data-status-option="待执行"]')?.click())
    await sleep(400)
    const it7b = await storedItem(dataId, '数据线快充横评')
    const lockedAgain = await ev(() => ({
      badge: document.querySelector('[data-status-badge]')?.textContent?.trim() ?? null,
      gridGone: !document.querySelector('[data-edit-field="roi"]'),
    }))
    ok(it7b?.roi === null && it7b?.status === '待执行', '待执行强制指标 null')
    eq(lockedAgain.badge, '待执行', '徽章待执行')
    ok(lockedAgain.gridGone, '指标网格消失')
    await ev(() => document.querySelector('[data-status-option="已发布"]')?.click())
    await sleep(400) // 弹窗保持打开，供 t45 复用
  })

  await t('t45 负责人编辑 + 成员管理（旧 v14OwnersAndMembers）', async () => {
    ok(dataId, '前置链路就绪')
    if (!(await ev(() => !!document.querySelector('[data-slot="dialog-content"]')))) {
      await openCard('数据线快充横评')
    }
    await ev(() => document.querySelector('[data-edit-field="content_owner_id"]')?.click())
    await waitFor(() => ev(() => !!document.querySelector('[data-edit-input="content_owner_id"]')), 4000, '内容负责人选择器')
    await page.select('[data-edit-input="content_owner_id"]', 'M-1003')
    await sleep(300)
    await ev(() => document.querySelector('[data-edit-field="delivery_owner_id"]')?.click())
    await waitFor(() => ev(() => !!document.querySelector('[data-edit-input="delivery_owner_id"]')), 4000, '投放负责人选择器')
    await page.select('[data-edit-input="delivery_owner_id"]', 'M-1002')
    const it7o = await waitFor(async () => {
      const i = await storedItem(dataId, '数据线快充横评')
      return i && i.content_owner_id === 'M-1003' ? i : null
    }, 5000, '负责人落库')
    eq(it7o.delivery_owner_id, 'M-1002', '投放负责人落库')
    await page.screenshot({ path: path.join(VDIR, 'board-v14-detail-owners.png') })
    await closeDialog()

    // 成员管理弹窗：3 行 + 苏晴计数「内容 1 · 投放 0」
    await ev(() => document.querySelector('[data-members-btn]')?.click())
    await waitFor(() => ev(() => !!document.querySelector('[data-members-dialog]')), 5000, '成员弹窗')
    const mBefore = await ev(() => {
      const rows = [...document.querySelectorAll('[data-members-dialog] [data-member-row]')]
      const su = rows.find((x) => x.dataset.memberId === 'M-1003')
      return { count: rows.length, suUsage: su?.querySelector('[data-member-usage]')?.textContent ?? null }
    })
    eq(mBefore.count, 3, '成员目录 3 行')
    eq(mBefore.suUsage, '内容 1 · 投放 0', '苏晴引用计数')

    await page.click('[data-member-add-input]')
    await page.keyboard.type('王五', { delay: 10 })
    await ev(() => document.querySelector('[data-member-add]')?.click())
    await waitFor(
      () => ev(() => document.querySelectorAll('[data-members-dialog] [data-member-row]').length === 4),
      5000,
      '新增后 4 行',
    )
    const mAdded = await ev(() => {
      const rows = [...document.querySelectorAll('[data-members-dialog] [data-member-row]')]
      const last = rows[rows.length - 1]
      return { id: last?.dataset.memberId ?? null, name: last?.querySelector('[data-member-name]')?.textContent ?? null }
    })
    eq(mAdded.id, 'M-1004', '自动 id M-1004')
    eq(mAdded.name, '王五', '新增姓名')

    // 姓名编辑态：冷启动首轮偶发丢 click（headless 下 mousedown/mouseup 之间节点被
    // 轮询提交的 React 重渲染置换，或事件落在组件未就绪窗口期），改 poll 式 click-until：
    // 每轮先确认当前相位（span 在 → 点击；input 已在 → 直接成功），1.2s 内未见编辑态则重试，最多 4 次
    const nameSel = '[data-member-row][data-member-id="M-1004"] [data-member-name]'
    await waitFor(
      () => ev((s) => !!document.querySelector(s) || !!document.querySelector('[data-member-name-input]'), nameSel),
      5000,
      'M-1004 姓名行就绪',
    )
    let editReady = false
    for (let attempt = 0; attempt < 4 && !editReady; attempt++) {
      const phase = await ev(
        (s) =>
          document.querySelector('[data-member-name-input]')
            ? 'editing'
            : document.querySelector(s)
              ? 'idle'
              : 'missing',
        nameSel,
      )
      if (phase === 'editing') {
        editReady = true
        break
      }
      if (phase !== 'idle') {
        await sleep(250)
        continue
      }
      await page.click(nameSel)
      editReady = await waitFor(() => ev(() => !!document.querySelector('[data-member-name-input]')), 1200, '').then(
        () => true,
        () => false,
      )
    }
    ok(editReady, '姓名编辑态（click-until 重试后进入）')
    await page.keyboard.type('王五改', { delay: 10 })
    await page.keyboard.press('Enter')
    await waitFor(
      () =>
        ev(
          () =>
            document.querySelector('[data-member-row][data-member-id="M-1004"] [data-member-name]')?.textContent ===
            '王五改',
        ),
      5000,
      '改名生效',
    )
    await waitFor(async () => (await storedDoc(dataId))?.members?.length === 4, 5000, 'members 落库 4 个')
    await page.screenshot({ path: path.join(VDIR, 'board-v14-members.png') })

    // 删除 M-1003（被 imp-0007 内容负责人引用）→ 引用卡降级「未分配」
    await ev(() => document.querySelector('[data-member-row][data-member-id="M-1003"] [data-member-delete]')?.click())
    await waitFor(
      () => ev(() => document.querySelectorAll('[data-members-dialog] [data-member-row]').length === 3),
      5000,
      '删除后 3 行',
    )
    await page.keyboard.press('Escape')
    await waitFor(() => ev(() => !document.querySelector('[data-members-dialog]')), 5000, '成员弹窗关闭')
    await openCard('数据线快充横评')
    const degraded = await ev(() => {
      const cell = document.querySelector('[data-slot="dialog-content"] [data-edit-field="content_owner_id"]')
      return { unassigned: !!cell?.querySelector('[data-detail-owner-unassigned]'), text: cell?.textContent?.trim() ?? null }
    })
    await closeDialog()
    ok(degraded.unassigned && degraded.text === '未分配', `删除后降级「未分配」（${degraded.text}）`)
  })

  await t('t46 UI 导入按姓名登记成员（旧 v14ImportMemberHint）', async () => {
    const tmp = path.join(VDIR, 'tmp-v14-member-import.json')
    writeFileSync(tmp, JSON.stringify({ items: [
      { id: 'ui-2001', type: '图文', title: 'v14成员登记演示', publish_at: '2026-08-29T10:00', product_id: 'P-2003', 内容负责人: '周舟', 投放负责人: '陈远', roi: 1.1, propagation_4h: 100, engagement_4h: 10 },
    ] }))
    try {
      await (await page.$('[data-import-input]')).uploadFile(tmp)
      await waitFor(() => ev(() => !!document.querySelector('[data-report-imported]')), 6000, '导入报告出现')
      const rep = await ev(() => ({
        imported: document.querySelector('[data-report-imported]')?.textContent ?? null,
        members: document.querySelector('[data-report-members-registered]')?.textContent ?? null,
      }))
      eq(rep.imported, '1', '导入 1 条')
      ok(rep.members?.includes('自动登记新成员 1 个'), `登记报告（${rep.members}）`)
      await page.screenshot({ path: path.join(VDIR, 'board-v14-import-members.png') })
      await page.keyboard.press('Escape')
      await waitFor(() => ev(() => !document.querySelector('[data-report-imported]')), 5000, '报告关闭')
      const mStored = await waitFor(async () => {
        const d = await storedDoc(dataId)
        return d?.members?.some((m) => m.name === '周舟') ? d.members : null
      }, 5000, '成员落库')
      eq(mStored.find((m) => m.name === '周舟')?.id, 'M-1005', '周舟自动 id M-1005')
      const itNew = await storedItem(dataId, 'v14成员登记演示')
      ok(itNew?.content_owner_id === 'M-1005' && itNew?.delivery_owner_id === 'M-1002' && itNew?.roi === 1.1, '导入行负责人/指标落库')
      const doc14 = await storedDoc(dataId)
      eq(doc14.items.length, 14, '数据层 14 张')
      eq(await renderedCount(), inWindowCount(doc14, await firstDate(), await lastDate()), '渲染数 = 窗口内 14')
    } finally {
      rmSync(tmp, { force: true })
    }
  })

  await t('t47 密码门 5 次失败锁定（旧 v15PasswordGate；t01 之外的限速核验）', async () => {
    ok(guideId, '前置 t20 就绪')
    const ctx = await browser.createBrowserContext()
    const pg = await ctx.newPage()
    await pg.setViewport(VIEW)
    try {
      await pg.goto(`${WEB}/b/${guideId}`, { waitUntil: 'domcontentloaded' })
      await pg.waitForFunction(() => !!document.querySelector('[data-gate]'), { timeout: 10000 })
      await pg.waitForFunction((n) => document.querySelector('[data-gate-name]')?.textContent === n, { timeout: 10000 }, GUIDE_NAME)
      await pg.screenshot({ path: path.join(VDIR, 'board-v15-gate.png') })
      for (let i = 1; i <= 5; i++) {
        await clearAndTypeOn(pg, '[data-gate-password]', `wrong-pw-${i}`)
        await pg.click('[data-gate-submit]')
        await sleep(500)
        const err = await pg.evaluate(() => document.querySelector('[data-gate-error]')?.textContent ?? null)
        if (i < 5) eq(err, '密码错误', `第 ${i} 次错误密码提示`)
        else ok(err?.includes('秒后重试'), `第 5 次触发锁定 429（${err}）`)
      }
      await clearAndTypeOn(pg, '[data-gate-password]', GUIDE_PASS) // 锁中正确密码也 429
      await pg.click('[data-gate-submit]')
      await sleep(500)
      const errLocked = await pg.evaluate(() => document.querySelector('[data-gate-error]')?.textContent ?? null)
      ok(errLocked?.includes('秒后重试'), `锁定期内正确密码同样 429（${errLocked}）`)
      await sleep(2500) // BOARD_LOCK_SECONDS=2，等锁过期
      await pg.click('[data-gate-submit]')
      await pg.waitForFunction(() => document.querySelectorAll('.h-full.overflow-auto [data-date]').length === 61, { timeout: 15000 })
      await sleep(600)
      const cards = await pg.evaluate(() => document.querySelectorAll('.h-full.overflow-auto [data-card-title]').length)
      eq(cards, 2, '进板 2 张引导卡')
    } finally {
      await ctx.close()
    }
  })

  await t('t48 双端同步：第二浏览器上下文看到他端改动（旧 v15SyncTwoContexts）', async () => {
    ok(dataId, '前置 t24 就绪')
    const ctxB = await browser.createBrowserContext()
    const pageB = await ctxB.newPage()
    await pageB.setViewport(VIEW)
    try {
      await pageB.goto(dataUrl(), { waitUntil: 'domcontentloaded' })
      await pageB.waitForFunction(() => !!document.querySelector('[data-gate]'), { timeout: 10000 })
      await pageB.waitForFunction((n) => document.querySelector('[data-gate-name]')?.textContent === n, { timeout: 10000 }, DATA_NAME)
      await clearAndTypeOn(pageB, '[data-gate-password]', DATA_PASS)
      await pageB.click('[data-gate-submit]')
      await pageB.waitForFunction(() => document.querySelectorAll('.h-full.overflow-auto [data-date]').length === 61, { timeout: 15000 })
      await sleep(1000)
      // 主上下文（A）改标题 → 推送（200ms 防抖）→ B 轮询（1s）看到
      await editCardTitleOn(page, 'E2E 新卡片', 'E2E 同步标题A')
      await pageB.waitForFunction(
        (t0) => [...document.querySelectorAll('[data-card-title]')].some((p) => p.textContent === t0),
        { timeout: 10000 },
        'E2E 同步标题A',
      )
    } finally {
      await ctxB.close()
    }
  })

  await t('t49 LWW 后写覆盖先写（旧 v15LWW）', async () => {
    ok(dataId, '前置 t24 就绪')
    const ctxB = await browser.createBrowserContext()
    const pageB = await ctxB.newPage()
    await pageB.setViewport(VIEW)
    try {
      await pageB.goto(dataUrl(), { waitUntil: 'domcontentloaded' })
      await pageB.waitForFunction(() => !!document.querySelector('[data-gate]'), { timeout: 10000 })
      await clearAndTypeOn(pageB, '[data-gate-password]', DATA_PASS)
      await pageB.click('[data-gate-submit]')
      await pageB.waitForFunction(() => document.querySelectorAll('.h-full.overflow-auto [data-date]').length === 61, { timeout: 15000 })
      await sleep(1000)
      // B 后写 → A 轮询应用整板 → 服务端真态亦为 B 的标题
      await editCardTitleOn(pageB, 'E2E 同步标题A', 'E2E 同步标题B')
      await page.waitForFunction(
        (t0) => [...document.querySelectorAll('[data-card-title]')].some((p) => p.textContent === t0),
        { timeout: 10000 },
        'E2E 同步标题B',
      )
      const auth2 = await api('POST', `/boards/${dataId}/auth`, { password: DATA_PASS })
      const docAfter = (await api('GET', `/boards/${dataId}`, undefined, auth2.body.token)).body.doc
      ok(
        docAfter.items.some((i) => i.title === 'E2E 同步标题B') &&
          !docAfter.items.some((i) => i.title === 'E2E 同步标题A'),
        '服务端 doc 体现 B 的后写',
      )
    } finally {
      await ctxB.close()
    }
  })

  await t('t50 离线编辑补推（旧 v15Offline）', async () => {
    ok(dataId, '前置 t24 就绪')
    await page.setOfflineMode(true)
    try {
      await sleep(300)
      await editCardTitleOn(page, 'E2E 同步标题B', 'E2E 离线标题') // 本地缓存改动，推送失败
      await waitFor(
        () => ev(() => document.querySelector('[data-sync-status]')?.dataset.syncStatus === 'offline'),
        8000,
        '离线状态点',
      )
    } finally {
      await page.setOfflineMode(false)
    }
    await waitFor(
      () => ev(() => document.querySelector('[data-sync-status]')?.dataset.syncStatus === 'synced'),
      10000,
      '恢复后自动补推 synced',
    )
    const auth2 = await api('POST', `/boards/${dataId}/auth`, { password: DATA_PASS })
    const docAfter = (await api('GET', `/boards/${dataId}`, undefined, auth2.body.token)).body.doc
    ok(docAfter.items.some((i) => i.title === 'E2E 离线标题'), '服务端 doc 含离线改动')
  })

  await t('t51 同步状态点 synced（旧 v15SyncDot）', async () => {
    const dot = await ev(() => {
      const el = document.querySelector('[data-sync-status]')
      return el ? { status: el.dataset.syncStatus, text: el.textContent.trim(), title: el.getAttribute('title') } : null
    })
    ok(dot && dot.status === 'synced' && dot.text.includes('已同步'), `状态点 ${JSON.stringify(dot)}`)
    await page.screenshot({ path: path.join(VDIR, 'board-v15-board-sync.png') })
  })

  await t('t52 CLI 空 product_id 导入行不跳过（旧 v11EmptyProductImport，纯 CLI 层）', async () => {
    const tmpCsv = path.join(VDIR, 'tmp-v11-empty-product.csv')
    writeFileSync(
      tmpCsv,
      '标题,类型,计划发布时间,产品ID\n临时无归属卡,图文,2026-08-20 10:00,\n临时正常卡,图文,2026-08-21 10:00,P-2003\n',
      'utf8',
    )
    let out = ''
    let code = 0
    try {
      out = execSync(`npm run import:data -- "${tmpCsv}"`, { cwd: ROOT, encoding: 'utf8' })
    } catch (err) {
      code = err.status ?? -1
      out = `${err.stdout ?? ''}${err.stderr ?? ''}`
    } finally {
      rmSync(tmpCsv, { force: true })
    }
    const j = JSON.parse(readFileSync(BOARD_JSON, 'utf8'))
    const empty = j.items?.find((i) => i.title === '临时无归属卡')
    eq(code, 0, 'CLI 退出码 0')
    ok(out.includes('未填写归属产品: 1 条'), '报告汇总「未填写归属产品: 1 条」')
    eq(j.items?.length, 2, 'board.json 2 条（空归属行未跳过）')
    eq(empty?.product_id, '', '空归属行 product_id 置空')
  })

  await t('t53 删除看板全链路（旧 v15DeleteBoard；t19 之外补 403/404/不存在页）', async () => {
    ok(prodId, '前置 t40 就绪')
    await page.goto(`${WEB}/`, { waitUntil: 'domcontentloaded' })
    await waitFor(() => ev(() => document.querySelectorAll('[data-board-row]').length === 4), 8000, '列表 4 块板（主/引导/数据/产品）')
    await sleep(500)
    await page.screenshot({ path: path.join(VDIR, 'board-v15-home.png') })

    await ev((id) => document.querySelector(`[data-board-row][data-board-id="${id}"] [data-board-delete]`)?.click(), prodId)
    await waitFor(() => ev(() => !!document.querySelector('[data-delete-dialog]')), 5000, '删除确认框')
    const dlg = await ev(() => ({
      name: document.querySelector('[data-delete-name]')?.textContent ?? null,
      cards: document.querySelector('[data-delete-cards]')?.textContent ?? null,
      updated: (document.querySelector('[data-delete-updated]')?.textContent ?? '').length > 0,
    }))
    eq(dlg.name, PROD_NAME, '确认框列出名称')
    eq(dlg.cards, '2', '确认框列出卡片数（引导卡 2 张）')
    ok(dlg.updated, '确认框列出最后更新')
    await page.screenshot({ path: path.join(VDIR, 'board-v15-delete-confirm.png') })

    await clearAndType('[data-delete-password]', 'wrong-pw') // 错密码 → 403
    await ev(() => document.querySelector('[data-delete-confirm]')?.click())
    await waitFor(() => ev(() => !!document.querySelector('[data-delete-error]')), 5000, '错密码报错')
    eq(await ev(() => document.querySelector('[data-delete-error]')?.textContent ?? null), '密码错误', '错密码提示')

    await clearAndType('[data-delete-password]', PROD_PASS) // 正确密码 → 物理删除
    await ev(() => document.querySelector('[data-delete-confirm]')?.click())
    await waitFor(() => ev(() => !document.querySelector('[data-delete-dialog]')), 6000, '删除完成')
    await waitFor(
      () => ev(() => document.querySelectorAll('[data-board-row]').length === 3),
      6000,
      '列表剩 3 块',
    )
    ok(await ev((id) => !document.querySelector(`[data-board-row][data-board-id="${id}"]`), prodId), '产品板行消失')

    const list = await api('GET', '/boards')
    ok(list.status === 200 && !list.body.boards.some((b) => b.board_id === prodId), 'API 列表无已删板')
    const got = await api('GET', `/boards/${prodId}`)
    eq(got.status, 404, 'GET 已删板 404')

    // 旧链接（本标签 sessionStorage 留有建板 token → 全量 GET 404 → 不存在页）
    await page.goto(`${WEB}/b/${prodId}`, { waitUntil: 'domcontentloaded' })
    await waitFor(() => ev(() => !!document.querySelector('[data-board-notfound]')), 10000, '看板不存在页')
    prodId = null // 已物理删除，清理段跳过
  })

  // 清掉全部测试板（不留测试数据；产品板已被 t53 删除）
  for (const [id, pw] of [
    [boardId, MAIN_PASS],
    [smallId, SMALL_PASS],
    [guideId, GUIDE_PASS],
    [dataId, DATA_PASS],
    [prodId, PROD_PASS],
  ]) {
    if (id) {
      try {
        await api('DELETE', `/boards/${id}`, { password: pw })
      } catch {
        // 清理失败不影响测试结果
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 入口：跑完/出错都清理（杀进程组 + 删 tmp sqlite）
// ---------------------------------------------------------------------------
console.log(`[e2e] v16 验证开始（今天 = ${TODAY}）`)
let exitCode = 0
try {
  await main()
} catch (e) {
  console.error('[e2e] 主流程异常：', e)
  results.push(['FAIL', '主流程', e])
} finally {
  await teardown()
}
const passed = results.filter(([s]) => s === 'PASS').length
const failed = results.filter(([s]) => s === 'FAIL').length
console.log(`\n[e2e] 结果：${passed} PASS / ${failed} FAIL（共 ${results.length} 项）`)
if (failed > 0) {
  for (const [, name, e] of results.filter(([s]) => s === 'FAIL')) {
    console.error(`  ✗ ${name}: ${e instanceof Error ? e.message : String(e)}`)
  }
  exitCode = 1
} else {
  console.log('[e2e] ALL PASS')
}
process.exit(exitCode)
