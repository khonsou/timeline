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
 *   样例锚点（examples/import-sample.json）不再直接使用：灌库前按 SAMPLE_SHIFT 平移全部
 *   publish_at（锚点 imp-0006 → 今天+2），任何运行日都落在 ±30 天窗口内且语义不变；
 *   规约：日期断言一律走 fmt/addDays/fmtTipDate 与 shiftDate/shiftAt，禁止字面量日期。
 *
 * v19 碰撞判定修复（t57）：全局 closestCorners 下拖拽卡自身 rect 长期赢下判定、
 *   相邻日落点无高亮成功率低；修复为 pointerWithin 锁列 + 列内 closestCorners。
 *   t57 断言「甩进邻列 30% 深处」时 over=目标列、isOver 高亮、落定切日且时分保留。
 *
 * M4 版本保护写路径（t58）：整板 PUT 带 If-Match；双端并发写 → 一端 409 →
 *   自动整板 GET + pending-patch 重放 + 带新版本重试，两端编辑都不丢；
 *   用离线门确定性制造版本落后，MutationObserver 记录状态轨迹断言经过「冲突恢复中」。
 *
 * v2-M1（t59–t62）：F1 背景色（设置/默认移除/持久化）、F2 置灰·点亮 toggle、
 *   F5 看板内搜索（Ctrl+K 唤起 / 窗口外卡定位高亮一次 / 空态 / Esc）、
 *   F6 分享链接（复制 toast / #card= 打开定位高亮 / 已删卡降级提示）。
 *
 * v2-M3（t67–t73）：F4 卡片多对多关系 + 关系视图——详情「前后关系」建边主入口
 *   （前序/后续对称增删 + post_ids 镜像落盘 + chip × 双侧剔除）、TopBar 视图切换 +
 *   hash 持久/直达、推进前线强调、拖拽连线建边、环降级断边、前序全发布点亮提示、
 *   删卡级联剔除、未连线卡片暂存带（折叠计数/展开/双向拖线建边/升入分层图/孤立卡定位升级）。
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

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..') // web 包根
const REPO_ROOT = path.resolve(ROOT, '..') // 仓库根（server/cli/examples/node_modules 所在）
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

// v15 移植用例的锚点：样例静态文件 examples/import-sample.json 不动，
// 灌库用 writeShiftedSample() 平移副本（见上方 SAMPLE_SHIFT 节）
const BOARD_JSON = path.join(ROOT, 'public', 'data', 'board.json')
const GUIDE_NAME = 'E2E 引导板'
const GUIDE_PASS = 'e2e-guide-pass'
const DATA_NAME = 'E2E 数据板'
const DATA_PASS = 'e2e-data-pass'
const PROD_NAME = 'E2E 产品板'
const PROD_PASS = 'e2e-prod-pass'
const GUIDE_TITLE_1 = '欢迎使用拾光轴 · 5 分钟上手'
const GUIDE_TITLE_2 = 'CLI 批量导入真实数据'
const EDIT_TARGET_TITLE = '数据日报 · 8 月合集' // imp-0005（平移后 = 今天-1，历史已发布）
const DELETE_TARGET_TITLE = '台灯新品图文首发' // imp-0006（平移后 = 今天+2，待发布）

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

// ---------------------------------------------------------------------------
// 样例夹具日期平移（免疫运行日漂移）：examples/import-sample.json 保持静态不动
// （仍是 CLI 文档示例），e2e 灌库前把全部 publish_at 按 SAMPLE_SHIFT 平移。
// 锚点：imp-0006 @ 2026-09-04 → 今天+2。选 +2 而非今天本身：
//   ① imp-0006 必须恒为「待发布」——锚到今天的 11:00 会被运行时刻污染（午后跑 → 已发布）；
//   ② 最早卡 imp-0001 @08-05 平移后落 今天-28，距窗口左缘（-30）留 2 天余量；
//   ③ imp-0005 @09-01 → 今天-1（恒为历史已发布，任意运行时刻安全）；
//   ④ imp-0007 @09-10 → 今天+8（恒为未来 → 推导待发布），imp-0008 @09-20 → 今天+18（窗口内）。
// 规约：日期断言一律走 fmt/addDays/fmtTipDate 与本节 shiftDate/shiftAt，禁止字面量日期。
// ---------------------------------------------------------------------------
const SAMPLE_ANCHOR_DATE = '2026-09-04' // imp-0006 原始 publish 日期
const SAMPLE_SHIFT = dayDiff(addDays(TODAY, 2), SAMPLE_ANCHOR_DATE)
/** 样例日期平移：'YYYY-MM-DD' → 平移后 */
const shiftDate = (d) => addDays(d, SAMPLE_SHIFT)
/** 样例日期时间平移：'YYYY-MM-DDTHH:mm'（保留时分） */
const shiftAt = (at) => `${shiftDate(at.slice(0, 10))}${at.slice(10)}`

/** 读静态样例 → 全部 publish_at 平移 → 写 VDIR 临时副本，返回路径（t24 灌库用） */
function writeShiftedSample() {
  const src = JSON.parse(readFileSync(path.join(REPO_ROOT, 'examples', 'import-sample.json'), 'utf8'))
  for (const it of src.items ?? []) {
    if (typeof it.publish_at === 'string') it.publish_at = shiftAt(it.publish_at)
  }
  const out = path.join(VDIR, 'tmp-import-sample.shifted.json')
  writeFileSync(out, JSON.stringify(src, null, 2))
  return out
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
  apiProc = spawn(process.execPath, [path.join(REPO_ROOT, 'packages/server/index.mjs')], {
    cwd: REPO_ROOT,
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
    [path.join(REPO_ROOT, 'node_modules/vite/bin/vite.js'), '--port', String(WEB_PORT), '--strictPort'],
    {
      cwd: ROOT, // vite 在 web 包内跑（index.html / vite.config.ts 所在）
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
  for (const f of ['tmp-v12-ui-import.json', 'tmp-v13-diff-import.json', 'tmp-v14-member-import.json', 'tmp-v11-empty-product.csv', 'tmp-import-sample.shifted.json']) {
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
    if (Date.now() - t0 > timeout) {
      // 超时诊断：把页面实况（URL/列数/门/同步态/正文头部）带进错误信息
      let diag = ''
      try {
        const d = await ev(() => ({
          url: location.pathname + location.search,
          gate: !!document.querySelector('[data-gate]'),
          sync: document.querySelector('[data-sync-status]')?.dataset.syncStatus ?? null,
          cols: document.querySelectorAll('.h-full.overflow-auto [data-date]').length,
          gcols: document.querySelectorAll('.h-full.overflow-auto [data-group-column]').length,
          cards: document.querySelectorAll('.h-full.overflow-auto [data-card-title]').length,
          body: document.body.innerText.replace(/\n/g, ' ').slice(0, 100),
        }))
        diag = ` | 实况 ${JSON.stringify(d)}`
      } catch {
        diag = ' | 实况读取失败'
      }
      throw new Error(`waitFor 超时${label ? `：${label}` : ''}${diag}`)
    }
    await sleep(120)
  }
}

const colCount = () => ev(() => document.querySelectorAll('.h-full.overflow-auto [data-date]').length)
const firstDate = () =>
  ev(() => document.querySelector('.h-full.overflow-auto [data-date]')?.dataset.date ?? null)
// v2-M2 统一分组模型：未分组虚拟列（无 data-date）恒为第一列，日期列整体右移一列 → idx -1
const midDate = () =>
  ev(() => {
    const s = document.querySelector('.h-full.overflow-auto')
    if (!s) return null
    const cols = [...s.querySelectorAll('[data-date]')]
    if (!cols.length) return null
    const idx = Math.round((s.scrollLeft + s.clientWidth / 2 - 16 - 118) / 248) - 1
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
/** v2-M2 统一分组模型：卡片标题 → 所在分组列 key（data-group-column；未分组 = 'ungrouped'） */
const cardGroupKey = (title) =>
  ev((t) => {
    const el = [...document.querySelectorAll('.h-full.overflow-auto [data-card-title]')].find(
      (p) => p.textContent === t,
    )
    return el ? (el.closest('[data-group-column]')?.dataset.groupColumn ?? null) : null
  }, title)
/** 分组列是否在视口内（key = 分组 id / 'ungrouped'） */
const groupColVisible = (key) =>
  ev((k) => {
    const s = document.querySelector('.h-full.overflow-auto')
    const c = s?.querySelector(`[data-group-column="${k}"]`)
    if (!s || !c) return false
    const sr = s.getBoundingClientRect()
    const cr = c.getBoundingClientRect()
    return cr.left < sr.right && cr.right > sr.left
  }, key)

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

  // v2-M2：离群卡（today±90）归「未分组」列，t02/t61/t62 断言见各用例

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

  await t('t02 首屏：迁移后 61 日期列 = 今天 ±30，今天列可见，全量 14 卡渲染', async () => {
    await page.goto(`${WEB}/b/${boardId}?poll=1000&push=200`, { waitUntil: 'domcontentloaded' })
    await waitFor(async () => (await colCount()) === 61, 9000, '渲染 61 日期列')
    eq(await firstDate(), addDays(TODAY, -30), '首列 = 今天-30')
    const last = await ev(() => {
      const cols = [...document.querySelectorAll('.h-full.overflow-auto [data-date]')]
      return cols[cols.length - 1]?.dataset.date
    })
    eq(last, addDays(TODAY, 30), '末列 = 今天+30')
    ok(await dateVisible(TODAY), '今天列首屏可见')
    const cards = await ev(() => document.querySelectorAll('.h-full.overflow-auto [data-card-title]').length)
    eq(cards, 14, '全量 14 张渲染（统一分组模型：离群卡归未分组列，不再隐藏）')
    // 出窗离群卡（today±90）：从「不渲染」变为「未分组列可见」（统一模型的有意行为变化）
    eq(await cardGroupKey('E2E 卡 01'), 'ungrouped', 'today-90 离群卡在未分组列')
    eq(await cardGroupKey('E2E 卡 14'), 'ungrouped', 'today+90 离群卡在未分组列')
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

  await t('t04 无滑动窗口：滚远后列集合不变，视觉位置随 scrollLeft 精确移动', async () => {
    // v2-M2 统一分组模型：滑动窗口退役——列全量常驻，滚动只改视觉位置
    const before = await ev(() => {
      const s = document.querySelector('.h-full.overflow-auto')
      const cols = [...s.querySelectorAll('[data-date]')]
      const d = cols[30] // 参照列 = 今天
      return { first: cols[0].dataset.date, D: d.dataset.date, left: d.getBoundingClientRect().left }
    })
    await ev(() => {
      document.querySelector('.h-full.overflow-auto').scrollLeft += 12 * 248
    })
    await sleep(300)
    const after = await ev((D) => {
      const s = document.querySelector('.h-full.overflow-auto')
      const cols = [...s.querySelectorAll('[data-date]')]
      const d = cols.find((c) => c.dataset.date === D)
      return { first: cols[0].dataset.date, left: d ? d.getBoundingClientRect().left : null, count: cols.length }
    }, before.D)
    eq(after.first, before.first, '首列不变（无窗口滑动重建）')
    eq(after.count, 61, '列数恒 61（全量常驻渲染）')
    ok(after.left !== null, '参照列恒在 DOM')
    const expectLeft = before.left - 12 * COLUMN_STEP
    ok(
      Math.abs(after.left - expectLeft) <= 4,
      `视觉位置随 scrollLeft 精确移动：${before.left.toFixed(1)} → ${after.left.toFixed(1)}，期望 ${expectLeft.toFixed(1)} ±4`,
    )
    // 滚回今天恢复现场
    await ev((d) => {
      const s = document.querySelector('.h-full.overflow-auto')
      const col = s.querySelector(`[data-date="${d}"]`)
      const r = col.getBoundingClientRect()
      const sr = s.getBoundingClientRect()
      s.scrollLeft += r.left - sr.left - 512
    }, TODAY)
    await sleep(300)
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

  await t('t06 键盘：→ +7 天 / ← -7 天 / Shift+← -30 天 / Shift+→ +30 天 / T 回今天', async () => {
    // v2-M2：键盘导航以「视口中线列的 data-date」为基准（组名可解析为日期才步进）；
    // 窗口固定 ±30，步进序列设计为全程落在窗口内（出窗目标 = 无操作）
    await ev(() => document.body.focus())
    await sleep(300)
    const m0 = await midDate()
    await page.keyboard.press('ArrowRight')
    await sleep(1400)
    const m1 = await midDate()
    ok(Math.abs(dayDiff(m1, m0) - 7) <= 1, `→ 后中线 ${m0} → ${m1}（预期 +7）`)
    await page.keyboard.press('ArrowLeft')
    await sleep(1400)
    const m2 = await midDate()
    ok(Math.abs(dayDiff(m2, m1) + 7) <= 1, `← 后中线 ${m1} → ${m2}（预期 -7）`)
    await page.keyboard.down('Shift')
    await page.keyboard.press('ArrowLeft')
    await page.keyboard.up('Shift')
    await sleep(1400)
    const m3 = await midDate()
    // today-30 是左缘列，居中滚动被 clamp 到 scrollLeft=0 → 中线落在 today-28 附近（容差 [-31,-27]）
    const d32 = dayDiff(m3, m2)
    ok(d32 >= -31 && d32 <= -27, `Shift+← 后中线 ${m2} → ${m3}（预期 -30，左缘 clamp 至 -28 附近）`)
    await page.keyboard.down('Shift')
    await page.keyboard.press('ArrowRight')
    await page.keyboard.up('Shift')
    await sleep(1400)
    const m4 = await midDate()
    ok(Math.abs(dayDiff(m4, m3) - 30) <= 1, `Shift+→ 后中线 ${m3} → ${m4}（预期 +30）`)
    await page.keyboard.press('t')
    await waitFor(() => dateVisible(TODAY), 8000, 'T 回今天')
    await sleep(500)
    ok(Math.abs(dayDiff(await midDate(), TODAY)) <= 1, 'T 后中线回到今天附近')
  })

  await t('t07 minimap 点击跳转（窗口内目标）+ 出窗点击无操作（双向同步）', async () => {
    const pt = await ev(() => {
      const r = document.querySelector('[data-minimap]').getBoundingClientRect()
      return { x: r.left, y: r.top + r.height / 2, w: r.width }
    })
    // v2-M2：列 = 迁移窗口（today±30）；span 仍 = today-90 → today+90（181 天）
    // 点 62% → floor(0.62×181)=112 → today+22（窗口内，有同名日期组列）
    const expect1 = addDays(TODAY, -90 + Math.floor(0.62 * 181))
    await page.mouse.click(pt.x + pt.w * 0.62, pt.y)
    await waitFor(async () => Math.abs(dayDiff(await midDate(), expect1)) <= 2, 7000, `点击跳到 ${expect1} 附近`)
    // 点回 50% → floor(0.5×181)=90 → today
    await page.mouse.click(pt.x + pt.w * 0.5, pt.y)
    await waitFor(async () => Math.abs(dayDiff(await midDate(), TODAY)) <= 2, 7000, '点击回今天')
    // 出窗点击（97% → today+85，无同名组列）→ 无操作（退化语义）
    const before = await midDate()
    await page.mouse.click(pt.x + pt.w * 0.97, pt.y)
    await sleep(600)
    eq(await midDate(), before, '出窗点击无操作（无同名日期组列）')
  })

  await t('t08 minimap 拖框先行 + tooltip 读数 + 窗口内大跳', async () => {
    const pt = await ev(() => {
      const r = document.querySelector('[data-minimap]').getBoundingClientRect()
      return { x: r.left, y: r.top + r.height / 2, w: r.width }
    })
    const fr = await ev(() => {
      const r = document.querySelector('[data-minimap-window]').getBoundingClientRect()
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
    })
    const mid60 = pt.x + pt.w * 0.6
    const target63 = pt.x + pt.w * 0.63 // floor(0.63×181)=113 → today+23（窗口内）
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
        await page.mouse.move(mid60 + ((target63 - mid60) * i) / 6, fr.y)
        await sleep(45)
      }
    } finally {
      await page.mouse.up()
    }
    const expectD = addDays(TODAY, -90 + Math.floor(0.63 * 181)) // ≈ today+23
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

  await t('t55 minimap 压暗静态：无滑动窗口，滚动不改变遮罩', async () => {
    // v2-M2：滑动窗口退役 → dim 遮罩恒 = 今天±30 窗口外两片（center 恒 TODAY），
    // 滚动只移动视口框，遮罩宽度不再变化
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
    const left0 = await ev(() => document.querySelector('.h-full.overflow-auto').scrollLeft)
    await ev(() => {
      document.querySelector('.h-full.overflow-auto').scrollLeft += 12 * 248
    })
    await sleep(400)
    eq(await firstDate(), before, '滚动后首列不变（无窗口滑动）')
    ok(
      (await ev(() => document.querySelector('.h-full.overflow-auto').scrollLeft)) > left0,
      'scrollLeft 确实移动',
    )
    const m2 = await readDims()
    ok(Math.abs(m2.l - m1.l) <= 1, `左压暗恒定（${m1.l.toFixed(1)} → ${m2.l.toFixed(1)}px）`)
    ok(Math.abs(m2.r - m1.r) <= 1, `右压暗恒定（${m1.r.toFixed(1)} → ${m2.r.toFixed(1)}px）`)
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

  await t('t11 详情页改 publish_at 出窗：归未分组列 + 视野跟随，可改回', async () => {
    // v2-M2 统一分组模型：改期到无同名日期组的日期 → 归「未分组」（不自动建组）；
    // 视野跟随到卡片新列（revealCard）；publish_at 本身保留（纯信息字段）
    const far = addDays(TODAY, 40)
    await openCard('E2E 新增卡')
    await editPublishAt(`${far}T09:00`)
    await waitFor(async () => (await cardGroupKey('E2E 新增卡')) === 'ungrouped', 6000, '出窗改期 → 归未分组列')
    await waitFor(() => groupColVisible('ungrouped'), 7000, '视野跟随到未分组列')
    const it = await storedItem(boardId, 'E2E 新增卡')
    eq(it?.publish_at, `${far}T09:00`, 'publish_at 保留（纯信息字段，不驱动分桶）')
    // 改回 today+1（有同名日期组 → 自动挂回；视野跟随回日期区）
    const back = addDays(TODAY, 1)
    await editPublishAt(`${back}T09:00`)
    await waitFor(async () => (await cardColumnDate('E2E 新增卡')) === back, 5000, '卡片挂回 today+1 同名日期组')
    await waitFor(() => dateVisible(back), 7000, 'today+1 列滚入视口')
    await closeDialog()
  })

  await t('t12 拖拽跨列：group_id 切换到目标日期组、publish_at 不变', async () => {
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
      // autoScroll 可能在驻留期间顶偏内容（指针落入左右缘 20% 热区会持续横滚）：
      // 迭代把指针校正回目标列当前中心，直到 over 命中目标列，再松手
      const wantGid = await ev(
        (d) => document.querySelector(`.h-full.overflow-auto [data-date="${d}"]`)?.dataset.groupKey ?? null,
        target,
      )
      for (let i = 0; i < 6; i++) {
        const over = await ev(() => window.__dndOver ?? null)
        if (over === `col-${wantGid}`) break
        const c = await ev((d) => {
          const col = document.querySelector(`.h-full.overflow-auto [data-date="${d}"]`)
          const r = col.getBoundingClientRect()
          const sr = document.querySelector('.h-full.overflow-auto').getBoundingClientRect()
          return {
            x: Math.max(sr.left + 40, Math.min(r.left + 118, sr.right - 40)),
            y: Math.min(r.top + 320, 800),
          }
        }, target)
        await page.mouse.move(c.x, c.y, { steps: 4 })
        await sleep(160)
      }
    } finally {
      await page.mouse.up()
    }
    // v2-M2：跨列拖拽只改列归属（group_id），publish_at 不再随拖拽变化
    await waitFor(async () => (await cardColumnDate('E2E 卡 05')) === target, 6000, '落定到 today+3 组列')
    await sleep(1200) // 等同步层落盘 localStorage
    const it = await storedItem(boardId, 'E2E 卡 05')
    eq(it?.publish_at, `${addDays(TODAY, -2)}T10:04`, 'publish_at 不随拖拽变化（纯信息字段）')
    const gid3 = await ev(
      (d) => document.querySelector(`.h-full.overflow-auto [data-date="${d}"]`)?.dataset.groupKey ?? null,
      target,
    )
    eq(it?.group_id, gid3, 'group_id 落盘 = 目标日期组 id')
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

  await t('t57 相邻列拖拽：甩进邻列 30% 深处即判定落点（v19 碰撞判定修复回归）', async () => {
    // 前置状态：t12 已把「E2E 卡 05」落定 today+3 组列（publish_at 恒为 today-2T10:04）
    const fromDate = addDays(TODAY, 3)
    eq(await cardColumnDate('E2E 卡 05'), fromDate, 't57 前提：卡 05 在 today+3 组列')
    // t13 的 autoScroll 改变了 scrollLeft，先把 today+3 滚到视口第 3 列（today+2/+4 均可见）
    await ev((d) => {
      const s = document.querySelector('.h-full.overflow-auto')
      const col = s.querySelector(`[data-date="${d}"]`)
      const r = col.getBoundingClientRect()
      const sr = s.getBoundingClientRect()
      s.scrollLeft += r.left - sr.left - 512
    }, fromDate)
    await sleep(400)
    // 目标 = 相邻空列：优先 today+2（ fixture 无卡），被占则用 today+4
    const cand = [addDays(TODAY, 2), addDays(TODAY, 4)]
    let target = null
    for (const d of cand) {
      const n = await ev((date) => document.querySelectorAll(`.h-full.overflow-auto [data-date="${date}"] [data-card-title]`).length, d)
      if (n === 0) { target = d; break }
    }
    ok(target, '找到相邻空列作为落点')
    // v2-M2：列 droppable id = col-<分组 id>（不再是 col-<日期>），按列元素 data-group-key 取
    const targetGid = await ev(
      (d) => document.querySelector(`.h-full.overflow-auto [data-date="${d}"]`)?.dataset.groupKey ?? null,
      target,
    )
    ok(targetGid, '目标列有分组 id')
    const from = await ev(() => {
      const el = [...document.querySelectorAll('.h-full.overflow-auto [data-card-title]')].find(
        (p) => p.textContent === 'E2E 卡 05',
      )
      const r = el.closest('.group').getBoundingClientRect()
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
    })
    const toX = await ev((d) => {
      const r = document.querySelector(`.h-full.overflow-auto [data-date="${d}"]`).getBoundingClientRect()
      return r.left + Math.round(r.width * 0.3) // 邻列左缘内侧 30%：旧判定下 over 仍是拖拽卡自身的位置
    }, target)
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    try {
      await page.mouse.move(from.x + (toX > from.x ? 30 : -30), from.y + 6, { steps: 4 })
      await sleep(80)
      await page.mouse.move(toX, from.y + 4, { steps: 10 })
      await sleep(280)
      // 判定级断言：指针在邻列 30% 深处，over 必须已是目标列（旧判定此处为拖拽卡自身）
      eq(await ev(() => window.__dndOver ?? null), `col-${targetGid}`, '拖拽中 over = 目标列')
      const ring = await ev((d) => {
        const col = document.querySelector(`.h-full.overflow-auto [data-date="${d}"]`)
        return col?.querySelector(':scope > .rounded-2xl')?.className.includes('ring-2') ?? false
      }, target)
      ok(ring, '目标列 isOver 高亮（落点反馈）')
      await page.screenshot({ path: path.join(VDIR, 'board-v19-adjacent-drag.png') })
    } finally {
      await page.mouse.up()
    }
    await waitFor(async () => (await cardColumnDate('E2E 卡 05')) === target, 6000, '落定相邻组列')
    await sleep(1200) // 等同步层落盘 localStorage
    const it = await storedItem(boardId, 'E2E 卡 05')
    eq(it?.publish_at, `${addDays(TODAY, -2)}T10:04`, 'publish_at 不随跨列拖拽变化（纯信息字段）')
    eq(it?.group_id, targetGid, 'group_id 落盘 = 目标日期组 id')
    await sleep(500) // 等 click 抑制解除
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
    // v2-M2：统一分组模型下归属由 group_id 决定；外部写入方需带上目标日期组 id
    // （服务端 doc 此时已含迁移回推的 61 组），否则注入卡按设计落「未分组」列
    const g2 = (doc.groups ?? []).find((g) => g.name === addDays(TODAY, 2))
    ok(g2, '服务端 doc 已含今天+2 日期组（迁移已回推）')
    ext.group_id = g2.id
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
  //   数据基础与旧套件同构：CLI 导入样例（writeShiftedSample() 平移副本）写 public/data/board.json
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
    const shifted = writeShiftedSample() // 静态样例平移到运行日窗口（见 SAMPLE_SHIFT 节）
    execSync(`npm run import:data -- "${shifted}"`, { cwd: REPO_ROOT, stdio: 'pipe' })
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
    // v16 窗口断言：渲染数 = 窗口内应渲染数（平移后样例全在窗口内，即 9）
    const inWin = inWindowCount(doc, await firstDate(), await lastDate())
    eq(await renderedCount(), inWin, '窗口内卡片全渲染')
    ok(await cardColumnDate('星轨键盘 SE 开箱视频'), `锚点卡渲染（窗口覆盖 ${shiftDate('2026-08-05')}）`)
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
    try {
      await waitFor(
        () => ev(() => document.querySelector('[data-detail-title]')?.textContent === 'E2E 修改标题'),
        5000,
        '标题提交',
      )
    } catch (e) {
      // flake 现场：输入框残值 / 标题元素 / 同步状态 / 缓存中该卡标题
      const dump = await ev(() => ({
        input: document.querySelector('input[placeholder="输入卡片标题…"]')?.value ?? null,
        detailTitle: document.querySelector('[data-detail-title]')?.textContent ?? null,
        dialogOpen: !!document.querySelector('[data-slot="dialog-content"]'),
        sync: document.querySelector('[data-sync-status]')?.dataset.syncStatus ?? null,
        active: document.activeElement?.tagName ?? null,
      }))
      const cached = await storedItem(dataId, 'E2E 修改标题')
      const cachedOld = await storedItem(dataId, EDIT_TARGET_TITLE)
      await page.screenshot({ path: path.join(VDIR, 't25-fail.png') }).catch(() => {})
      console.error(`    [t25 现场] ${JSON.stringify(dump)} 缓存新标题=${!!cached} 缓存旧标题=${!!cachedOld}`)
      throw e
    }
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

  await t('t29 数据板跨列拖拽：今天组 → 明天组（group_id 切换、publish_at 不变；旧 dragAcrossDays）', async () => {
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
    // v2-M2：拖拽只改 group_id；publish_at 保持创建时的今天
    const it29 = await storedItem(dataId, 'E2E 新卡片')
    ok(it29?.publish_at?.startsWith(`${TODAY}T`), 'publish_at 保持今天（不随拖拽变化）')
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
      '复盘记录：本次内容投放节奏符合预期，首小时曝光爬坡较快，评论区高频问题集中在售价与配色两个点；后续跟进需要在详情页补充尺寸对照表，并安排一场直播集中答疑，同时把用户晒单整理成二次传播素材。详见 https://example.com/review'
    let LONG = ''
    for (let i = 1; LONG.length < 1600; i++) LONG += (LONG ? '\n\n' : '') + `第${i}段　${para}`
    await openCard(v6Title)
    await ev(() => document.querySelector('[data-comment-edit]')?.click())
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
    // URL 链接化：备注中的 URL 渲染为可点 <a>（新标签页），且文本不再 click-to-edit
    const link = await ev(
      () => document.querySelector('[data-edit-field="comment"] a[href="https://example.com/review"]')?.tagName ?? null,
    )
    await closeDialog()
    ok(rendered === LONG, `重开渲染完整（${rendered?.length} 字）`)
    ok(link === 'A', '备注内 URL 渲染为可点链接')
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
    execSync('npm run import:data -- --products examples/products-sample.json', { cwd: REPO_ROOT, stdio: 'pipe' })
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
      { id: 'ui-0001', type: '图文', title: 'UI导入图文', product_id: 'P-2003', status: '已发布', publish_at: shiftAt('2026-08-25T10:00'), metrics: { views: 1, likes: 2, comments: 3, favorites: 4, shares: 5, follows: 6, conversions: 7 } },
      { id: 'ui-0002', type: '视频', title: 'UI导入无产品', product_id: '', status: '待发布', publish_at: shiftAt('2026-08-26T11:00') },
      { id: 'ui-0003', type: '图文', title: '', product_id: 'P-2003', status: '已发布', publish_at: shiftAt('2026-08-25T10:00') },
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
        { id: 'ui-1001', type: '图文', title: 'v13自动登记演示', publish_at: shiftAt('2026-08-27T10:00'), product_id: 'P-3100', product_name: '幻影 mini 主机', roi: 1.5, propagation_4h: 100, engagement_4h: 10 },
        { id: 'ui-1002', type: '视频', title: 'v13占位名演示', publish_at: shiftAt('2026-08-27T12:00'), product_id: 'P-3200' },
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

    // B. 状态联动：imp-0007（平移后 = 今天+8，未来 → 推导待发布，指标锁定占位）
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
      { id: 'ui-2001', type: '图文', title: 'v14成员登记演示', publish_at: shiftAt('2026-08-29T10:00'), product_id: 'P-2003', 内容负责人: '周舟', 投放负责人: '陈远', roi: 1.1, propagation_4h: 100, engagement_4h: 10 },
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

  await t('t58 双端并发写：一端 409 → 冲突自动恢复且两端编辑都不丢（M4 If-Match + pending-patch 重放）', async () => {
    ok(dataId, '前置 t24 就绪')
    const ctxB = await browser.createBrowserContext()
    const pageB = await ctxB.newPage()
    await pageB.setViewport(VIEW)
    let step = 'init'
    try {
      step = 'B 进板'
      await pageB.goto(dataUrl(), { waitUntil: 'domcontentloaded' })
      await pageB.waitForFunction(() => !!document.querySelector('[data-gate]'), { timeout: 10000 })
      await clearAndTypeOn(pageB, '[data-gate-password]', DATA_PASS)
      await pageB.click('[data-gate-submit]')
      await pageB.waitForFunction(() => document.querySelectorAll('.h-full.overflow-auto [data-date]').length === 61, { timeout: 15000 })
      await sleep(1000)
      step = 'A 同步就绪'
      await waitFor(
        () => ev(() => document.querySelector('[data-sync-status]')?.dataset.syncStatus === 'synced'),
        8000,
        'A 同步就绪',
      )
      // MutationObserver 记录 A 的同步状态轨迹（捕获「冲突恢复中」中间态，rapid 跳变不丢）
      await ev(() => {
        const w = window
        w.__syncTrail = [document.querySelector('[data-sync-status]')?.dataset.syncStatus ?? '?']
        w.__syncObs = new MutationObserver((ms) => {
          for (const m of ms) {
            const s = m.target?.dataset?.syncStatus
            if (s && w.__syncTrail[w.__syncTrail.length - 1] !== s) w.__syncTrail.push(s)
          }
        })
        w.__syncObs.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['data-sync-status'] })
      })
      // A 离线改卡 Y：编辑进本地 pending，推送失败 → offline（确定性制造 A 版本落后）
      step = 'A 离线'
      await page.setOfflineMode(true)
      await sleep(300)
      step = 'A 离线编辑卡Y'
      await editCardTitleOn(page, 'E2E 离线标题', 'E2E 并发标题A')
      step = 'A 离线状态点'
      await waitFor(
        () => ev(() => document.querySelector('[data-sync-status]')?.dataset.syncStatus === 'offline'),
        8000,
        'A 离线状态点',
      )
      // B 在线改卡 X 并推送（version+1），等它确实落到服务端
      step = 'B 改卡X'
      await editCardTitleOn(pageB, 'E2E 修改标题', 'E2E 并发标题B')
      step = 'B 落服务端'
      const authB = await api('POST', `/boards/${dataId}/auth`, { password: DATA_PASS })
      await waitFor(async () => {
        const d = (await api('GET', `/boards/${dataId}`, undefined, authB.body.token)).body?.doc
        return d?.items?.some((i) => i.title === 'E2E 并发标题B')
      }, 8000, 'B 的并发写入已落服务端')
      // A 恢复在线 → tick 补推带旧版本 → 409 → 自动整板 GET + pending 重放 + 重试 → synced
      step = 'A 恢复在线'
      await page.setOfflineMode(false)
      step = 'A 自动恢复'
      await waitFor(
        () => ev(() => document.querySelector('[data-sync-status]')?.dataset.syncStatus === 'synced'),
        15000,
        'A 409 自动恢复 synced',
      )
      step = 'A 双编辑断言'
      // 不丢编辑：A 端既保留自己的离线编辑，也采纳 B 的并发改动
      ok(await cardColumnDate('E2E 并发标题A'), 'A 的离线编辑保留（未被覆盖）')
      await waitFor(async () => (await cardColumnDate('E2E 并发标题B')) !== null, 8000, 'A 采纳 B 的并发改动')
      // 状态轨迹经过「冲突恢复中」中间态
      step = '轨迹断言'
      const trail = await ev(() => window.__syncTrail)
      ok(Array.isArray(trail) && trail.includes('conflict'), `经过冲突恢复中（${(trail ?? []).join('→')}）`)
      // 服务端真态：两端编辑都在
      const authC = await api('POST', `/boards/${dataId}/auth`, { password: DATA_PASS })
      const docC = (await api('GET', `/boards/${dataId}`, undefined, authC.body.token)).body.doc
      ok(docC.items.some((i) => i.title === 'E2E 并发标题A'), '服务端含 A 编辑')
      ok(docC.items.some((i) => i.title === 'E2E 并发标题B'), '服务端含 B 编辑')
      // B 端轮询看到 A 恢复的编辑
      step = 'B 看到 A'
      await pageB.waitForFunction(
        (t0) => [...document.querySelectorAll('[data-card-title]')].some((p) => p.textContent === t0),
        { timeout: 10000 },
        'E2E 并发标题A',
      )
    } catch (e) {
      // 失败现场：步骤 + 两端卡面标题 + A 状态轨迹 + 截图（flake 排查用）
      const aTitles = await ev(() => [...document.querySelectorAll('[data-card-title]')].map((p) => p.textContent).slice(0, 20)).catch(() => null)
      const bTitles = await pageB.evaluate(() => [...document.querySelectorAll('[data-card-title]')].map((p) => p.textContent).slice(0, 20)).catch(() => null)
      const trail = await ev(() => window.__syncTrail ?? null).catch(() => null)
      const aStatus = await ev(() => document.querySelector('[data-sync-status]')?.dataset.syncStatus ?? null).catch(() => null)
      await page.screenshot({ path: path.join(VDIR, 't58-fail-a.png') }).catch(() => {})
      await pageB.screenshot({ path: path.join(VDIR, 't58-fail-b.png') }).catch(() => {})
      await page.setOfflineMode(false).catch(() => {})
      console.error(`    [t58 现场] step=${step} A状态=${aStatus} 轨迹=${JSON.stringify(trail)}`)
      console.error(`    [t58 现场] A卡面=${JSON.stringify(aTitles)}`)
      console.error(`    [t58 现场] B卡面=${JSON.stringify(bTitles)}`)
      throw new Error(`${e instanceof Error ? e.message : String(e)}（step=${step}）`)
    } finally {
      await ctxB.close()
    }
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
      `标题,类型,计划发布时间,产品ID\n临时无归属卡,图文,${shiftDate('2026-08-20')} 10:00,\n临时正常卡,图文,${shiftDate('2026-08-21')} 10:00,P-2003\n`,
      'utf8',
    )
    let out = ''
    let code = 0
    try {
      out = execSync(`npm run import:data -- "${tmpCsv}"`, { cwd: REPO_ROOT, encoding: 'utf8' })
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

  // ------------------------------------------------------------------
  // v2-M1：F1 背景色 / F2 置灰·点亮 / F5 搜索 / F6 分享链接（共用定位机制）
  // ------------------------------------------------------------------
  await t('t59 F1 背景色：色板设置 sky → 落盘为 hex；选「默认」移除字段', async () => {
    await page.goto(`${WEB}/b/${boardId}?poll=1000&push=200`, { waitUntil: 'domcontentloaded' })
    await waitFor(async () => (await colCount()) === 61, 9000, '主板渲染 61 列')
    // 取窗口内第一张渲染卡作为操作对象（前序用例可能挪过日期，标题不变）
    const title = await ev(
      () => document.querySelector('.h-full.overflow-auto [data-card-title]')?.textContent ?? null,
    )
    ok(title, '窗口内有渲染卡')
    const before = await storedItem(boardId, title)
    ok(before && !('bg_color' in before), '旧数据无 bg_color 字段（默认白底）')
    // v2-M1b：渲染 = .card-bg 类 + 行内 style 的 --card-bgc hex（不再走 Tailwind 色阶类）
    const rootProbe = () =>
      ev((t) => {
        const el = [...document.querySelectorAll('.h-full.overflow-auto [data-card-title]')].find(
          (p) => p.textContent === t,
        )
        const root = el?.closest('[data-card-id]')
        return { cls: root?.className ?? '', style: root?.getAttribute('style') ?? '' }
      }, title)

    // 打开色板 → 选 sky（写入的是预设 hex，不是 token）
    await ev((t) => {
      const el = [...document.querySelectorAll('.h-full.overflow-auto [data-card-title]')].find(
        (p) => p.textContent === t,
      )
      el?.closest('[data-card-id]')?.querySelector('[data-card-bg-btn]')?.click()
    }, title)
    await waitFor(() => ev(() => !!document.querySelector('[data-bg-palette]')), 4000, '色板浮层')
    await ev(() => document.querySelector('[data-bg-swatch="sky"]')?.click())
    await waitFor(
      async () => {
        const r = await rootProbe()
        return r.cls.includes('card-bg') && r.style.includes('--card-bgc: #0ea5e9')
      },
      4000,
      '卡面底色经 --card-bgc 切到 sky hex',
    )
    await waitFor(
      async () => (await storedItem(boardId, title))?.bg_color === '#0ea5e9',
      4000,
      'bg_color 落盘为 hex（非 token）',
    )
    // 目标卡滚入视口再截图（直观核验 hex 淡底渲染）
    await ev((t) => {
      const el = [...document.querySelectorAll('.h-full.overflow-auto [data-card-title]')].find(
        (p) => p.textContent === t,
      )
      el?.closest('[data-card-id]')?.scrollIntoView({ block: 'nearest', inline: 'center' })
    }, title)
    await sleep(300)
    await page.screenshot({ path: path.join(VDIR, 'board-v2-m1b-bgcolor.png') })

    // 选「默认」→ 字段移除，视觉回到默认白底
    await ev((t) => {
      const el = [...document.querySelectorAll('.h-full.overflow-auto [data-card-title]')].find(
        (p) => p.textContent === t,
      )
      el?.closest('[data-card-id]')?.querySelector('[data-card-bg-btn]')?.click()
    }, title)
    await waitFor(() => ev(() => !!document.querySelector('[data-bg-palette]')), 4000, '色板浮层再开')
    await ev(() => document.querySelector('[data-bg-swatch="default"]')?.click())
    await waitFor(
      async () => {
        const r = await rootProbe()
        return r.cls.includes('bg-white') && !r.cls.includes('card-bg')
      },
      4000,
      '卡面恢复默认白底',
    )
    await waitFor(
      async () => !('bg_color' in ((await storedItem(boardId, title)) ?? {})),
      4000,
      'bg_color 字段已移除（不写 null）',
    )
  })

  await t('t60 F2 置灰/点亮：toggle 半透明 → 再 toggle 恢复；字段随缓存落盘', async () => {
    const title = await ev(
      () => document.querySelector('.h-full.overflow-auto [data-card-title]')?.textContent ?? null,
    )
    ok(title, '窗口内有渲染卡')
    const rootCls = () =>
      ev((t) => {
        const el = [...document.querySelectorAll('.h-full.overflow-auto [data-card-title]')].find(
          (p) => p.textContent === t,
        )
        return el?.closest('[data-card-id]')?.className ?? ''
      }, title)
    const clickDim = () =>
      ev((t) => {
        const el = [...document.querySelectorAll('.h-full.overflow-auto [data-card-title]')].find(
          (p) => p.textContent === t,
        )
        el?.closest('[data-card-id]')?.querySelector('[data-card-dim-toggle]')?.click()
      }, title)

    await clickDim()
    await waitFor(async () => (await rootCls()).includes('opacity-[0.45]'), 4000, '整卡 opacity 0.45')
    ok((await rootCls()).includes('saturate-50'), '去饱和')
    await waitFor(
      async () => (await storedItem(boardId, title))?.dimmed === true,
      4000,
      'dimmed=true 持久化',
    )

    await clickDim() // 点亮：字段移除
    await waitFor(async () => !(await rootCls()).includes('opacity-[0.45]'), 4000, '恢复不透明')
    await waitFor(
      async () => !('dimmed' in ((await storedItem(boardId, title)) ?? {})),
      4000,
      'dimmed 字段已移除',
    )
  })

  await t('t61 F5 搜索：Ctrl+K 唤起 → 未分组离群卡可搜到并定位高亮；空态；Esc 关闭', async () => {
    // 离群卡（today-90）：统一分组模型下在「未分组」列渲染
    eq(await cardGroupKey('E2E 卡 01'), 'ungrouped', '前置：离群卡在未分组列')
    await page.keyboard.down('Control')
    await page.keyboard.press('k')
    await page.keyboard.up('Control')
    await waitFor(() => ev(() => !!document.querySelector('[data-search-palette]')), 4000, '搜索面板唤起')
    await page.click('[data-search-input]')
    await page.keyboard.type('E2E 卡 01', { delay: 10 })
    await waitFor(
      () =>
        ev(() => {
          const rows = [...document.querySelectorAll('[data-search-result]')]
          return rows.length === 1 && (rows[0].textContent?.includes('未分组') ?? false)
        }),
      4000,
      '结果含目标卡，副标题 = 未分组',
    )
    await ev(() => document.querySelector('[data-search-result]')?.click())
    await waitFor(() => ev(() => !document.querySelector('[data-search-palette]')), 4000, '面板关闭')
    await waitFor(() => groupColVisible('ungrouped'), 9000, '未分组列滚入视口')
    await waitFor(
      () => ev(() => !!document.querySelector('[data-card-highlight="true"]')),
      4000,
      '卡片一次性高亮',
    )
    await sleep(2300) // 高亮只播一次，自动撤除
    ok(
      await ev(() => !document.querySelector('[data-card-highlight="true"]')),
      '高亮到时自动撤除（不循环闪）',
    )

    // 空态 + Esc 关闭
    await page.keyboard.down('Control')
    await page.keyboard.press('k')
    await page.keyboard.up('Control')
    await waitFor(() => ev(() => !!document.querySelector('[data-search-palette]')), 4000, '面板再开')
    await page.click('[data-search-input]')
    await page.keyboard.type('绝不存在的关键词xyz', { delay: 10 })
    await waitFor(() => ev(() => !!document.querySelector('[data-search-empty]')), 4000, '空态提示')
    await page.keyboard.press('Escape')
    await waitFor(() => ev(() => !document.querySelector('[data-search-palette]')), 4000, 'Esc 关闭')

    // v2-M1c：产品名参与匹配（归属产品「光轴」的卡都应命中；期望数从 API 实时取，
    // 前序用例在主板上有增删卡，不能写死）
    const docNow = await api('GET', `/boards/${boardId}`, undefined, token)
    const dd = typeof docNow.body.doc === 'string' ? JSON.parse(docNow.body.doc) : docNow.body.doc
    const expected = dd.items.filter((it) => it.product_id === 'P-1000').length
    await page.keyboard.down('Control')
    await page.keyboard.press('k')
    await page.keyboard.up('Control')
    await waitFor(() => ev(() => !!document.querySelector('[data-search-palette]')), 4000, '面板三开')
    await page.click('[data-search-input]')
    await page.keyboard.type('光轴', { delay: 10 })
    await waitFor(
      () => ev((en) => document.querySelectorAll('[data-search-result]').length === en, expected),
      4000,
      `按产品名「光轴」搜到全部 ${expected} 张卡`,
    )
    await page.keyboard.press('Escape')
    await waitFor(() => ev(() => !document.querySelector('[data-search-palette]')), 4000, 'Esc 再关')
  })

  await t('t62 F6 分享链接：复制 toast；#card= 打开定位高亮；已删卡优雅降级', async () => {
    // 复制入口：卡片工具条「复制分享链接」→ toast 确认
    await ev(() => document.querySelector('.h-full.overflow-auto [data-card-copy-link]')?.click())
    await waitFor(
      () => ev(() => document.querySelector('[data-toast]')?.textContent === '分享链接已复制'),
      4000,
      '复制 toast 确认',
    )

    // 带 #card= 打开（先回列表再进板，避免同 URL 仅 hash 变化不触发整页重载）：
    // 目标是未分组列的离群卡 e2e-c01（today-90）——视野应滚到未分组列并高亮
    await page.goto(`${WEB}/`, { waitUntil: 'domcontentloaded' })
    await page.goto(`${WEB}/b/${boardId}?poll=1000&push=200#card=e2e-c01`, { waitUntil: 'domcontentloaded' })
    await waitFor(async () => (await colCount()) === 61, 9000, '看板正常打开（61 日期列）')
    await waitFor(() => groupColVisible('ungrouped'), 9000, '未分组列滚入视口')
    await waitFor(
      () => ev(() => document.querySelector('[data-card-highlight="true"]')?.dataset.cardId === 'e2e-c01'),
      4000,
      '分享目标卡高亮',
    )

    // 已删除/不存在的卡片 → 正常开板 + toast「卡片不存在或已删除」
    await page.goto(`${WEB}/`, { waitUntil: 'domcontentloaded' })
    await page.goto(`${WEB}/b/${boardId}?poll=1000&push=200#card=e2e-c99`, { waitUntil: 'domcontentloaded' })
    await waitFor(async () => (await colCount()) === 61, 9000, '看板正常打开（不白屏）')
    await waitFor(
      () => ev(() => document.querySelector('[data-toast]')?.textContent === '卡片不存在或已删除'),
      6000,
      '降级 toast 提示',
    )
    await page.screenshot({ path: path.join(VDIR, 'board-v2-m1-share.png') })
  })

  // ------------------------------------------------------------------
  // v2-M2 F3 统一分组模型（t63–t66）
  // ------------------------------------------------------------------
  let migId = null // t63 迁移板捕获（清理用）

  await t('t63 统一分组：存量板加载自动迁移（61 日期组 + 未分组首列 + 逐卡回填落盘）', async () => {
    // 全新存量板（doc 无 groups 字段）→ 前端加载时自动迁移派生 61 个日期组
    const legacy = fixtureDoc('E2E 迁移板')
    const mk2 = await api('POST', '/boards', { name: 'E2E 迁移板', password: MAIN_PASS, doc: legacy })
    eq(mk2.status, 201, '创建迁移板')
    migId = mk2.body.board_id
    const auth2 = await api('POST', `/boards/${migId}/auth`, { password: MAIN_PASS })
    const migToken = auth2.body.token
    await ev((k, tk) => sessionStorage.setItem(k, tk), `timeline-board-v4:token:${migId}`, migToken)
    await page.goto(`${WEB}/b/${migId}?poll=1000&push=200`, { waitUntil: 'domcontentloaded' })
    await waitFor(async () => (await colCount()) === 61, 9000, '迁移后 61 日期列')
    // 未分组虚拟列恒第一（无 data-date）
    const firstCol = await ev(() => {
      const c = document.querySelector('.h-full.overflow-auto [data-group-column]')
      return { key: c?.dataset.groupColumn ?? null, hasDate: c?.hasAttribute('data-date') ?? null }
    })
    eq(firstCol.key, 'ungrouped', '第一列 = 未分组虚拟列')
    eq(firstCol.hasDate, false, '未分组列无 data-date')
    eq(await firstDate(), addDays(TODAY, -30), '首日期列 = 今天-30')
    eq(await lastDate(), addDays(TODAY, 30), '末日期列 = 今天+30')
    // 迁移落盘（同步层推回服务端）：61 组 + 窗口内 12 卡回填 + 离群卡 2 张不留组
    const getDoc = async () => (await api('GET', `/boards/${migId}`, undefined, migToken)).body.doc
    await waitFor(async () => {
      const d = await getDoc()
      return d.groups?.length === 61 && d.items.filter((it) => it.group_id).length === 12
    }, 9000, '迁移落盘：61 组 + 窗口内 12 卡回填 group_id')
    const d1 = await getDoc()
    ok(
      !d1.items.find((it) => it.id === 'e2e-c01').group_id &&
        !d1.items.find((it) => it.id === 'e2e-c14').group_id,
      '窗口外离群卡（±90）不留组',
    )
    ok(
      d1.items
        .filter((it) => it.group_id)
        .every((it) =>
          d1.groups.some((g) => g.id === it.group_id && g.name === it.publish_at.slice(0, 10)),
        ),
      '逐卡 group_id 指向 publish_at 同名日期组',
    )
    // 幂等：reload 后 groups id 集合不变（确定性 migrateGroupId + 已落盘不再重迁）
    const ids0 = d1.groups.map((g) => g.id).join(',')
    await page.goto(`${WEB}/b/${migId}?poll=1000&push=200`, { waitUntil: 'domcontentloaded' })
    await waitFor(async () => (await colCount()) === 61, 9000, 'reload 后仍 61 列')
    const d2 = await getDoc()
    eq(d2.groups.map((g) => g.id).join(','), ids0, '迁移幂等：组 id 集合不变')
    // 61 满员：「+ 新建分组」禁用并提示上限
    const addBtn = await ev(() => {
      const b = document.querySelector('[data-add-group]')
      return { disabled: b?.disabled ?? null, title: b?.getAttribute('title') ?? null }
    })
    eq(addBtn.disabled, true, '61 满员新建禁用')
    ok(addBtn.title?.includes('61'), '禁用提示含上限文案')
  })

  await t('t64 统一分组：列头行内改名 / Esc 取消 / grip 整列排序 / 删除确认归未分组 / 新建上限', async () => {
    await page.goto(`${WEB}/b/${boardId}?poll=1000&push=200`, { waitUntil: 'domcontentloaded' })
    await waitFor(async () => (await colCount()) === 61, 9000, '主板 61 日期列')
    const sd0 = await storedDoc(boardId)
    eq(sd0.groups.length, 61, '迁移组已随同步落盘（61）')

    // -- 行内改名：点击名称 → input（自动全选）→ 输入即替换 → Enter 保存
    const g0 = sd0.groups[0] // today-30 日期组（空组）
    await ev((gid) => {
      document.querySelector(`[data-group-column="${gid}"] [data-group-name]`)?.click()
    }, g0.id)
    await waitFor(() => ev(() => !!document.querySelector('[data-group-name-input]')), 4000, '改名输入框出现')
    await sleep(150) // 等 select() 全选生效
    await page.keyboard.type('冲刺阶段', { delay: 10 })
    await page.keyboard.press('Enter')
    await waitFor(
      async () => (await storedDoc(boardId)).groups.find((g) => g.id === g0.id)?.name === '冲刺阶段',
      4000,
      '改名落盘',
    )
    // 改为自定义名后该列不再是日期组：data-date 消失
    ok(
      await ev(
        (gid) => !document.querySelector(`[data-group-column="${gid}"]`)?.hasAttribute('data-date'),
        g0.id,
      ),
      '改为自定义名后 data-date 消失',
    )

    // -- Esc 取消：第二个组开始编辑后 Esc → 名称不变
    const g1 = (await storedDoc(boardId)).groups[1]
    await ev((gid) => {
      document.querySelector(`[data-group-column="${gid}"] [data-group-name]`)?.click()
    }, g1.id)
    await waitFor(() => ev(() => !!document.querySelector('[data-group-name-input]')), 4000, '第二个改名输入框')
    await sleep(150)
    await page.keyboard.type('随便改改', { delay: 8 })
    await page.keyboard.press('Escape')
    await sleep(250)
    eq((await storedDoc(boardId)).groups.find((g) => g.id === g1.id)?.name, g1.name, 'Esc 取消改名')

    // -- grip 整列拖拽排序：第一组列拖到第二组列上 → 两组互换（先滚回最左让两列入视口）
    await ev(() => {
      document.querySelector('.h-full.overflow-auto').scrollLeft = 0
    })
    await sleep(300)
    const orderBefore = (await storedDoc(boardId)).groups.map((g) => g.id)
    const grip = await ev((gid) => {
      const el = document.querySelector(`[data-group-column="${gid}"] [data-group-grip]`)
      const r = el.getBoundingClientRect()
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
    }, g0.id)
    const over2 = await ev((gid) => {
      const el = document.querySelector(`[data-group-column="${gid}"]`)
      const r = el.getBoundingClientRect()
      return { x: r.left + Math.round(r.width / 2), y: r.top + 40 }
    }, g1.id)
    ok(grip.x > 0 && over2.x > 0, '两目标列在视口内')
    await page.mouse.move(grip.x, grip.y)
    await page.mouse.down()
    try {
      await page.mouse.move(grip.x + 20, grip.y, { steps: 3 })
      await sleep(80)
      await page.mouse.move(over2.x, over2.y, { steps: 8 })
      await sleep(280)
    } finally {
      await page.mouse.up()
    }
    await waitFor(
      async () => {
        const g = (await storedDoc(boardId)).groups.map((x) => x.id)
        return g[0] === orderBefore[1] && g[1] === orderBefore[0]
      },
      4000,
      '拖拽后前两组互换（数组序 = 列顺序）',
    )
    await sleep(600) // 等 grip 拖拽后的 click 抑制解除（150ms 窗口 + 余量），否则下面的删除点击会被吞

    // -- 删除确认：今天组 → 确认气泡带卡片数 → 组内卡片归未分组
    // （成员动态取：t13/t57 等拖拽已改变部分卡片的列归属，不写死 fixture 名单）
    const sdBeforeDel = await storedDoc(boardId)
    const todayGid = sdBeforeDel.groups.find((g) => g.name === TODAY)?.id
    ok(todayGid, '存在今天同名日期组')
    const delMembers = sdBeforeDel.items.filter((it) => it.group_id === todayGid)
    ok(delMembers.length > 0, `今天组内有卡（${delMembers.length} 张）`)
    await ev((gid) => {
      document.querySelector(`[data-group-column="${gid}"] [data-group-delete]`)?.click()
    }, todayGid)
    await waitFor(() => ev(() => !!document.querySelector('[data-group-delete-confirm]')), 4000, '删除确认气泡')
    const cnt = await ev(() => document.querySelector('[data-group-delete-count]')?.textContent ?? '')
    ok(cnt.includes(`${delMembers.length} 张`), `确认框带组内卡片数（${cnt}）`)
    await ev(() => document.querySelector('[data-group-delete-ok]')?.click())
    await waitFor(async () => (await storedDoc(boardId)).groups.length === 60, 4000, '删组落盘（61 → 60）')
    await waitFor(async () => {
      const sd = await storedDoc(boardId)
      return delMembers.every((m) => !sd.items.find((it) => it.id === m.id)?.group_id)
    }, 4000, '组内卡片归未分组（group_id 移除）')
    eq(await cardGroupKey(delMembers[0].title), 'ungrouped', '组内卡落在未分组列')

    // -- 末尾「+ 新建分组」：60 组可建 → 建后 61 满员禁用 → 删空组恢复 60
    eq(await ev(() => document.querySelector('[data-add-group]')?.disabled ?? null), false, '60 组时新建可用')
    await ev(() => document.querySelector('[data-add-group]')?.click())
    await waitFor(async () => (await storedDoc(boardId)).groups.length === 61, 4000, '新建分组落盘（末尾追加）')
    const lastG = (await storedDoc(boardId)).groups.at(-1)
    eq(lastG.name, '未命名分组', '新组默认名')
    eq(await ev(() => document.querySelector('[data-add-group]')?.disabled ?? null), true, '满 61 后新建禁用')
    await ev((gid) => {
      document.querySelector(`[data-group-column="${gid}"] [data-group-delete]`)?.click()
    }, lastG.id)
    await waitFor(() => ev(() => !!document.querySelector('[data-group-delete-confirm]')), 4000, '空组确认气泡')
    await ev(() => document.querySelector('[data-group-delete-ok]')?.click())
    await waitFor(async () => (await storedDoc(boardId)).groups.length === 60, 4000, '删空组恢复 60')

    // -- 未分组兜底：整板 PUT 写入悬空 group_id → 重载后该卡归「未分组」列且字段被重置
    const full = await api('GET', `/boards/${boardId}`, undefined, token)
    const dd = full.body.doc
    const victim = dd.items.find((it) => it.group_id)
    const victimTitle = victim.title
    victim.group_id = 'grp-ghost'
    await api('PUT', `/boards/${boardId}`, { doc: dd }, token)
    await page.goto(`${WEB}/b/${boardId}?poll=1000&push=200`, { waitUntil: 'domcontentloaded' })
    await waitFor(() => ev(() => !!document.querySelector('[data-group-column="ungrouped"]')), 9000, '看板重载')
    await waitFor(async () => (await cardGroupKey(victimTitle)) === 'ungrouped', 6000, '悬空卡归未分组列')
    await waitFor(
      async () => {
        const sd = await storedDoc(boardId)
        const it = sd.items.find((x) => x.title === victimTitle)
        return it && !('group_id' in it)
      },
      4000,
      '悬空 group_id 加载时重置（字段移除，不污染真实分组）',
    )
  })

  await t('t65 统一分组：跨组拖拽往返（拖入改 group_id + 重取 order；拖回未分组移除字段）', async () => {
    // 起点：未分组列里有卡（t02 离群卡 + t64 删组归入的卡 + 悬空兜底卡）
    const sd = await storedDoc(boardId)
    const targetGroup = sd.groups[0]
    const victim = sd.items.find((it) => !it.group_id)
    ok(victim, '未分组列有可拖拽卡')
    // 滚回最左（未分组列与第一组列均可见）
    await ev(() => {
      document.querySelector('.h-full.overflow-auto').scrollLeft = 0
    })
    await sleep(300)
    const from = await ev((t0) => {
      const el = [...document.querySelectorAll('.h-full.overflow-auto [data-card-title]')].find(
        (p) => p.textContent === t0,
      )
      if (!el) return null
      const r = el.closest('.group').getBoundingClientRect()
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
    }, victim.title)
    const to = await ev((gid) => {
      const col = document.querySelector(`[data-group-column="${gid}"]`)
      if (!col) return null
      const r = col.getBoundingClientRect()
      return { x: r.left + Math.round(r.width * 0.5), y: Math.min(r.top + 300, 800) }
    }, targetGroup.id)
    ok(from && to && to.x > 0, '拖拽源/目标在视口内')
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    try {
      await page.mouse.move(from.x + 30, from.y + 6, { steps: 4 })
      await sleep(80)
      await page.mouse.move(to.x, to.y, { steps: 12 })
      await sleep(280)
    } finally {
      await page.mouse.up()
    }
    await waitFor(async () => (await cardGroupKey(victim.title)) === targetGroup.id, 6000, '落定到目标分组列')
    await waitFor(
      async () => (await storedItem(boardId, victim.title))?.group_id === targetGroup.id,
      4000,
      'group_id 落盘为目标分组',
    )
    // 跨组重取 order：目标组内按 orders 升序包含该卡
    const sd2 = await storedDoc(boardId)
    const inTarget = sd2.items
      .filter((it) => it.group_id === targetGroup.id)
      .sort((a, b) => (sd2.orders[a.id] ?? 0) - (sd2.orders[b.id] ?? 0))
    ok(inTarget.some((it) => it.id === victim.id), '目标组内按全局 orders 排序可见')

    // 拖回未分组列 → group_id 字段移除
    // 第一次拖拽可能触发 dnd-kit 边缘自动滚动，导致未分组列移出视口；
    // 先滚回最左再取坐标，且整段重试一次兜底（坐标捕获与 mouse.down 之间的重渲染会让拖拽落空）
    let backOk = false
    for (let attempt = 0; attempt < 2 && !backOk; attempt++) {
      await ev(() => {
        document.querySelector('.h-full.overflow-auto').scrollLeft = 0
      })
      await sleep(300)
      const from2 = await ev((t0) => {
        const el = [...document.querySelectorAll('.h-full.overflow-auto [data-card-title]')].find(
          (p) => p.textContent === t0,
        )
        if (!el) return null
        const r = el.closest('.group').getBoundingClientRect()
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
      }, victim.title)
      const to2 = await ev(() => {
        const col = document.querySelector('[data-group-column="ungrouped"]')
        const r = col.getBoundingClientRect()
        return { x: r.left + Math.round(r.width * 0.5), y: Math.min(r.top + 300, 800) }
      })
      ok(from2 && to2 && to2.x > 0, `拖回：源/目标在视口内（attempt ${attempt + 1}）`)
      await page.mouse.move(from2.x, from2.y)
      await page.mouse.down()
      try {
        await page.mouse.move(from2.x - 30, from2.y + 6, { steps: 4 })
        await sleep(80)
        await page.mouse.move(to2.x, to2.y, { steps: 12 })
        await sleep(280)
      } finally {
        await page.mouse.up()
      }
      backOk = await Promise.race([
        (async () => {
          try {
            await waitFor(async () => (await cardGroupKey(victim.title)) === 'ungrouped', 3000, '拖回探测')
            return true
          } catch {
            return false
          }
        })(),
        sleep(3200).then(() => false),
      ])
    }
    await waitFor(async () => (await cardGroupKey(victim.title)) === 'ungrouped', 3000, '拖回未分组列')
    await waitFor(
      async () => !('group_id' in ((await storedItem(boardId, victim.title)) ?? {})),
      4000,
      '拖入未分组 = 移除 group_id 字段',
    )
    await sleep(500)
  })

  await t('t66 统一分组：写入时归属解析（change-set 建卡）+ 搜索副标题 + 日期导航退化', async () => {
    // 写入时归属解析：change-set create 带 publish_at 无 group_id →
    // 窗口内有同名日期组则挂入；出窗 → 归未分组（绝不自动建组）
    const d5 = addDays(TODAY, 5)
    const d45 = addDays(TODAY, 45)
    const ver = (await api('GET', `/boards/${boardId}`, undefined, token)).body.version
    const cs = await api(
      'POST',
      `/boards/${boardId}/change-sets`,
      {
        base_version: ver,
        operations: [
          { op: 'create', client_ref: 'w-hit', item: { title: 'E2E 解析卡', publish_at: `${d5}T10:00` } },
          { op: 'create', client_ref: 'w-miss', item: { title: 'E2E 出窗解析卡', publish_at: `${d45}T10:00` } },
        ],
      },
      token,
    )
    eq(cs.status, 201, 'change-set 创建 201')
    const cm = await api('POST', `/boards/${boardId}/change-sets/${cs.body.change_set_id}/commit`, {}, token)
    eq(cm.status, 200, 'change-set commit 200')
    // 页面轮询（poll=1000）应用远端快照
    await waitFor(async () => (await cardColumnDate('E2E 解析卡')) === d5, 9000, '窗口内建卡 → 挂同名日期组列')
    await waitFor(async () => (await cardGroupKey('E2E 出窗解析卡')) === 'ungrouped', 9000, '出窗建卡 → 归未分组')
    const sd66 = await storedDoc(boardId)
    const g5 = sd66.groups.find((g) => g.name === d5)
    ok(g5, 'today+5 同名日期组存在')
    eq(sd66.items.find((it) => it.title === 'E2E 解析卡')?.group_id, g5.id, '解析卡 group_id = 同名日期组')
    ok(!sd66.items.find((it) => it.title === 'E2E 出窗解析卡')?.group_id, '出窗解析卡无 group_id')
    ok(!sd66.groups.some((g) => g.name === d45), '未自动建出窗日期组')

    // 搜索副标题 = 分组名（日期组同名 / 未分组）
    await page.keyboard.down('Control')
    await page.keyboard.press('k')
    await page.keyboard.up('Control')
    await waitFor(() => ev(() => !!document.querySelector('[data-search-palette]')), 4000, '搜索面板唤起')
    await page.click('[data-search-input]')
    await page.keyboard.type('E2E 解析卡', { delay: 10 })
    await waitFor(
      () =>
        ev(
          (n) =>
            [...document.querySelectorAll('[data-search-result] [data-search-subtitle]')].some(
              (s) => s.textContent === n,
            ),
          d5,
        ),
      4000,
      '解析卡副标题 = 同名日期组名',
    )
    // 点击定位 → 目标分组列滚入视口 + 一次性高亮
    await ev((t0) => {
      const row = [...document.querySelectorAll('[data-search-result]')].find((r) =>
        r.textContent.includes(t0),
      )
      row?.click()
    }, 'E2E 解析卡')
    await waitFor(() => ev(() => !document.querySelector('[data-search-palette]')), 4000, '面板关闭')
    await waitFor(() => groupColVisible(g5.id), 6000, '目标分组列滚入视口')
    await waitFor(
      () =>
        ev(
          (t0) =>
            [...document.querySelectorAll('[data-card-highlight="true"] [data-card-title]')].some(
              (p) => p.textContent === t0,
            ),
          'E2E 解析卡',
        ),
      4000,
      '定位卡一次性高亮',
    )
    // 出窗卡副标题 = 未分组
    await page.keyboard.down('Control')
    await page.keyboard.press('k')
    await page.keyboard.up('Control')
    await waitFor(() => ev(() => !!document.querySelector('[data-search-palette]')), 4000, '面板再开')
    await page.click('[data-search-input]')
    await page.keyboard.type('E2E 出窗解析卡', { delay: 10 })
    await waitFor(
      () =>
        ev(
          () =>
            [...document.querySelectorAll('[data-search-result] [data-search-subtitle]')].some(
              (s) => s.textContent === '未分组',
            ),
        ),
      4000,
      '出窗卡副标题 = 未分组',
    )
    await page.keyboard.press('Escape')
    await waitFor(() => ev(() => !document.querySelector('[data-search-palette]')), 4000, 'Esc 关闭')

    // 日期导航退化：把 today+5 组改名为非日期 → data-date 消失；中线停在该列时 → 无操作
    await ev((gid) => {
      document.querySelector(`[data-group-column="${gid}"] [data-group-name]`)?.click()
    }, g5.id)
    await waitFor(() => ev(() => !!document.querySelector('[data-group-name-input]')), 4000, '改名输入框')
    await sleep(150)
    await page.keyboard.type('Sprint 5', { delay: 8 })
    await page.keyboard.press('Enter')
    await waitFor(
      async () => (await storedDoc(boardId)).groups.find((g) => g.id === g5.id)?.name === 'Sprint 5',
      4000,
      '改名落盘',
    )
    // 组改名卡片不跟随（落盘恒为 group_id，引用稳定）
    eq(
      (await storedDoc(boardId)).items.find((it) => it.title === 'E2E 解析卡')?.group_id,
      g5.id,
      '组改名卡片不跟随',
    )
    // 中线移到该列 → 键盘步进无操作
    await ev((gid) => {
      const s = document.querySelector('.h-full.overflow-auto')
      const col = s.querySelector(`[data-group-column="${gid}"]`)
      const r = col.getBoundingClientRect()
      const sr = s.getBoundingClientRect()
      s.scrollLeft += r.left - sr.left - sr.width / 2 + r.width / 2
    }, g5.id)
    await sleep(400)
    await ev(() => document.body.focus())
    const m0 = await midDate()
    await page.keyboard.press('ArrowRight')
    await sleep(700)
    eq(await midDate(), m0, '中线列为非日期组名：→ 无操作（导航退化）')
    // 中线回到日期组列 → 键盘步进恢复
    await ev((d) => {
      const s = document.querySelector('.h-full.overflow-auto')
      const col = s.querySelector(`[data-date="${d}"]`)
      if (!col) return
      const r = col.getBoundingClientRect()
      const sr = s.getBoundingClientRect()
      s.scrollLeft += r.left - sr.left - sr.width / 2 + r.width / 2
    }, addDays(TODAY, 4))
    await sleep(400)
    const n0 = await midDate()
    await page.keyboard.press('ArrowLeft')
    await sleep(700)
    ok(dayDiff(await midDate(), n0) <= -6, '中线回到日期组列后键盘步进恢复（-7）')
  })

  // ------------------------------------------------------------------
  // v2-M3 F4 卡片多对多关系 + 关系视图（t67–t72，专用关系板避免主板残留干扰）
  // 初始 fixture：c01–c05 已发布（过去），c06–c14 待发布（今天起）
  // ------------------------------------------------------------------
  let relId = null // 关系板捕获（清理用）
  const relToken = { v: null }

  await t('t67 前后关系：详情建边主入口（前序/后续对称增删 + 镜像落盘 + chip × 双侧剔除）', async () => {
    const mk = await api('POST', '/boards', {
      name: 'E2E 关系板',
      password: MAIN_PASS,
      doc: fixtureDoc('E2E 关系板'),
    })
    eq(mk.status, 201, '创建关系板')
    relId = mk.body.board_id
    relToken.v = (await api('POST', `/boards/${relId}/auth`, { password: MAIN_PASS })).body.token
    await ev((k, tk) => sessionStorage.setItem(k, tk), `timeline-board-v4:token:${relId}`, relToken.v)
    await page.goto(`${WEB}/b/${relId}?poll=1000&push=200`, { waitUntil: 'domcontentloaded' })
    await waitFor(async () => (await colCount()) === 61, 9000, '关系板加载 61 列')

    // 前序添加：E2E 卡 06 ← E2E 卡 05（点击候选）
    await openCard('E2E 卡 06')
    await waitFor(() => ev(() => !!document.querySelector('[data-relations]')), 4000, '前后关系小节渲染')
    await ev(() => document.querySelector('[data-rel-add="pre"]')?.click())
    await waitFor(() => ev(() => !!document.querySelector('[data-rel-picker]')), 4000, '前序选择器唤起')
    await ev(() => document.querySelector('[data-rel-input]')?.focus())
    await page.keyboard.type('E2E 卡 05', { delay: 10 })
    await waitFor(() => ev(() => !!document.querySelector('[data-rel-option]')), 4000, '前序候选出现')
    await ev(() => document.querySelector('[data-rel-option]')?.click())
    await waitFor(async () => {
      const d = await storedDoc(relId)
      const c06 = d?.items.find((i) => i.id === 'e2e-c06')
      const c05 = d?.items.find((i) => i.id === 'e2e-c05')
      return c06?.pre_ids?.includes('e2e-c05') && c05?.post_ids?.includes('e2e-c06')
    }, 6000, 'pre_ids 写入 + post_ids 镜像落盘')

    // 后续添加：E2E 卡 06 → E2E 卡 08（= 把本卡写进 08 的 pre_ids，单一写入源）
    await ev(() => document.querySelector('[data-rel-add="post"]')?.click())
    await waitFor(() => ev(() => !!document.querySelector('[data-rel-picker]')), 4000, '后续选择器唤起')
    await ev(() => document.querySelector('[data-rel-input]')?.focus())
    await page.keyboard.type('E2E 卡 08', { delay: 10 })
    await waitFor(() => ev(() => !!document.querySelector('[data-rel-option]')), 4000, '后续候选出现')
    await ev(() => document.querySelector('[data-rel-option]')?.click())
    await waitFor(async () => {
      const d = await storedDoc(relId)
      const c08 = d?.items.find((i) => i.id === 'e2e-c08')
      const c06 = d?.items.find((i) => i.id === 'e2e-c06')
      return c08?.pre_ids?.includes('e2e-c06') && c06?.post_ids?.includes('e2e-c08')
    }, 6000, '添加后续 = 写入目标卡 pre_ids + 本卡镜像')
    // 方案 B+（决策 #11）：后续行与前序对称可增删——chip 带 ×（写对方卡 pre_ids）
    eq(
      await ev(() => document.querySelectorAll('[data-rel-row="post"] [data-rel-remove]').length),
      1,
      '后续行 chip 带 ×（对称可删）',
    )
    eq(
      await ev(() => document.querySelectorAll('[data-rel-row="post"] [data-rel-chip]').length),
      1,
      '后续行 chip 展示',
    )

    // 前序 chip × 移除 → 双侧同步剔除
    await ev(() => document.querySelector('[data-rel-row="pre"] [data-rel-remove]')?.click())
    await waitFor(async () => {
      const d = await storedDoc(relId)
      const c06 = d?.items.find((i) => i.id === 'e2e-c06')
      const c05 = d?.items.find((i) => i.id === 'e2e-c05')
      return !(c06?.pre_ids ?? []).includes('e2e-c05') && !(c05?.post_ids ?? []).includes('e2e-c06')
    }, 6000, '× 移除后 pre/post 双侧剔除')

    // 后续 chip × 移除 → 对方卡 pre_ids 与本卡 post_ids 同步剔除（双侧落盘）
    await ev(() => document.querySelector('[data-rel-row="post"] [data-rel-remove]')?.click())
    await waitFor(async () => {
      const d = await storedDoc(relId)
      const c08 = d?.items.find((i) => i.id === 'e2e-c08')
      const c06 = d?.items.find((i) => i.id === 'e2e-c06')
      return !(c08?.pre_ids ?? []).includes('e2e-c06') && !(c06?.post_ids ?? []).includes('e2e-c08')
    }, 6000, '× 移除后续：对方卡 pre_ids + 本卡 post_ids 双侧剔除')

    // 回加前序（Enter 快捷选第一条候选）——供 t68 前线断言用
    await ev(() => document.querySelector('[data-rel-add="pre"]')?.click())
    await ev(() => document.querySelector('[data-rel-input]')?.focus())
    await page.keyboard.type('E2E 卡 05', { delay: 10 })
    await waitFor(() => ev(() => !!document.querySelector('[data-rel-option]')), 4000, '前序候选再现')
    await page.keyboard.press('Enter')
    await waitFor(async () => {
      const d = await storedDoc(relId)
      return d?.items.find((i) => i.id === 'e2e-c06')?.pre_ids?.includes('e2e-c05')
    }, 6000, 'Enter 回加前序落盘')

    // 回加后续 c08——供 t68 边/前线与 t69 成环断言用
    await ev(() => document.querySelector('[data-rel-add="post"]')?.click())
    await ev(() => document.querySelector('[data-rel-input]')?.focus())
    await page.keyboard.type('E2E 卡 08', { delay: 10 })
    await waitFor(() => ev(() => !!document.querySelector('[data-rel-option]')), 4000, '后续候选再现')
    await ev(() => document.querySelector('[data-rel-option]')?.click())
    await waitFor(async () => {
      const d = await storedDoc(relId)
      return d?.items.find((i) => i.id === 'e2e-c08')?.pre_ids?.includes('e2e-c06')
    }, 6000, '回加后续落盘（c08.pre_ids 含 c06）')
    await closeDialog()
  })

  await t('t68 关系视图：切换 + hash 持久/直达 + 推进前线 + #card= 定位 + 孤立卡降级', async () => {
    await ev(() => document.querySelector('[data-view-tab="graph"]')?.click())
    await waitFor(() => ev(() => !!document.querySelector('[data-graph-view]')), 6000, '关系视图渲染')
    ok(await ev(() => location.hash.includes('view=graph')), 'hash 同步 view=graph')
    // 只渲染有关系的卡：c05/c06/c08 在图中，孤立卡 c01 不进图
    for (const id of ['e2e-c05', 'e2e-c06', 'e2e-c08']) {
      ok(await ev((i) => !!document.querySelector(`[data-graph-node="${i}"]`), id), `节点 ${id} 渲染`)
    }
    ok(!(await ev(() => !!document.querySelector('[data-graph-node="e2e-c01"]'))), '孤立卡不进图')
    // 边存在；推进前线 = pre 已发布 → post 未发布（c05→c06 前线 / c06→c08 双侧待发布不强调）
    ok(await ev(() => !!document.querySelector('[data-graph-edge="e2e-c05→e2e-c06"]')), '边 c05→c06 存在')
    ok(await ev(() => !!document.querySelector('[data-graph-edge="e2e-c06→e2e-c08"]')), '边 c06→c08 存在')
    ok(
      await ev(() => !!document.querySelector('[data-graph-edge="e2e-c05→e2e-c06"][data-edge-frontier="true"]')),
      '前线边 c05→c06 强调',
    )
    ok(
      !(await ev(() => !!document.querySelector('[data-graph-edge="e2e-c06→e2e-c08"][data-edge-frontier]'))),
      '非前线边 c06→c08 不强调',
    )
    // 前序发布 → 前线推进到 c06→c08（轮询应用远端快照）
    const p1 = await api('PATCH', `/boards/${relId}/items/e2e-c06`, { status: '已发布' }, relToken.v)
    eq(p1.status, 200, 'PATCH c06 已发布')
    await waitFor(
      () => ev(() => !!document.querySelector('[data-graph-edge="e2e-c06→e2e-c08"][data-edge-frontier="true"]')),
      9000,
      '前线推进到 c06→c08',
    )

    // hash 直达：#view=graph 刷新保持关系视图（先回列表避免同 URL 仅 hash 变化不重载）
    await page.goto(`${WEB}/`, { waitUntil: 'domcontentloaded' })
    await page.goto(`${WEB}/b/${relId}?poll=1000&push=200#view=graph`, { waitUntil: 'domcontentloaded' })
    await waitFor(() => ev(() => !!document.querySelector('[data-graph-view]')), 9000, '#view=graph 直达关系视图')
    // #view=graph&card= 定位节点一次性高亮
    await page.goto(`${WEB}/`, { waitUntil: 'domcontentloaded' })
    await page.goto(`${WEB}/b/${relId}?poll=1000&push=200#view=graph&card=e2e-c08`, {
      waitUntil: 'domcontentloaded',
    })
    await waitFor(
      () => ev(() => document.querySelector('[data-graph-node="e2e-c08"]')?.dataset.cardHighlight === 'true'),
      9000,
      '图视图 #card= 定位节点高亮',
    )

    // 孤立卡定位（搜索面板入口）→ 展开暂存带 + 横滚居中 + 一次性高亮（方案 1 升级，不再 toast）
    await page.keyboard.down('Control')
    await page.keyboard.press('k')
    await page.keyboard.up('Control')
    await waitFor(() => ev(() => !!document.querySelector('[data-search-palette]')), 4000, '搜索面板唤起')
    await ev(() => document.querySelector('[data-search-input]')?.focus())
    await page.keyboard.type('E2E 卡 01', { delay: 10 })
    await waitFor(() => ev(() => !!document.querySelector('[data-search-result]')), 4000, '孤立卡可搜到')
    await ev((t0) => {
      const row = [...document.querySelectorAll('[data-search-result]')].find((r) => r.textContent.includes(t0))
      row?.click()
    }, 'E2E 卡 01')
    await waitFor(
      () => ev(() => document.querySelector('[data-stage-card="e2e-c01"]')?.dataset.cardHighlight === 'true'),
      4000,
      '暂存带展开并高亮孤立卡',
    )
    ok(await ev(() => !!document.querySelector('[data-graph-view]')), '关系视图保持')
  })

  await t('t69 关系视图：拖拽连线建边（手柄 → 目标节点落盘）', async () => {
    // c08 → c06（与既有 c06→c08 构成环，供 t70 断言降级）
    const geo = await ev(() => {
      const from = document.querySelector('[data-graph-node="e2e-c08"]')
      const to = document.querySelector('[data-graph-node="e2e-c06"]')
      const h = from?.querySelector('[data-edge-handle]')
      if (!from || !to || !h) return null
      const hr = h.getBoundingClientRect()
      const tr = to.getBoundingClientRect()
      return {
        hx: hr.left + hr.width / 2,
        hy: hr.top + hr.height / 2,
        tx: tr.left + tr.width / 2,
        ty: tr.top + tr.height / 2,
      }
    })
    ok(geo, '源/目标节点坐标就绪')
    await page.mouse.move(geo.hx, geo.hy)
    await sleep(120)
    await page.mouse.down()
    for (let i = 1; i <= 6; i += 1) {
      await page.mouse.move(geo.hx + ((geo.tx - geo.hx) * i) / 6, geo.hy + ((geo.ty - geo.hy) * i) / 6)
      await sleep(40)
    }
    ok(await ev(() => !!document.querySelector('[data-graph-connecting]')), '拖拽中临时虚线')
    await page.mouse.up()
    await waitFor(async () => {
      const d = await storedDoc(relId)
      return d?.items.find((i) => i.id === 'e2e-c06')?.pre_ids?.includes('e2e-c08')
    }, 6000, '拖拽建边落盘：c06.pre_ids 含 c08')
    ok(await ev(() => !!document.querySelector('[data-graph-edge="e2e-c08→e2e-c06"]')), '新边 c08→c06 渲染')
  })

  await t('t70 环降级：断边标黄虚线 + 图不卡死 + 详情 × 拆环恢复', async () => {
    // t69 构成 c06→c08→c06 环：恰 1 条断边，两节点仍渲染
    await waitFor(
      () => ev(() => document.querySelectorAll('[data-edge-broken="true"]').length === 1),
      6000,
      '环降级：恰 1 条断边标黄',
    )
    for (const id of ['e2e-c06', 'e2e-c08']) {
      ok(await ev((i) => !!document.querySelector(`[data-graph-node="${i}"]`), id), `环上节点 ${id} 仍渲染`)
    }
    // 图节点点击开详情（onClick 在 CardView 卡面根节点上）→ chip × 拆掉 c06 的前序 c08
    await ev(() => document.querySelector('[data-graph-node="e2e-c06"] [data-card-title]')?.click())
    await waitFor(() => ev(() => !!document.querySelector('[data-slot="dialog-content"]')), 4000, '图节点开详情')
    await ev(() => {
      const chip = [...document.querySelectorAll('[data-rel-row="pre"] [data-rel-chip]')].find((c) =>
        c.textContent.includes('E2E 卡 08'),
      )
      chip?.querySelector('[data-rel-remove]')?.click()
    })
    await waitFor(async () => {
      const d = await storedDoc(relId)
      return !(d?.items.find((i) => i.id === 'e2e-c06')?.pre_ids ?? []).includes('e2e-c08')
    }, 6000, '断环边移除落盘')
    await closeDialog()
    await waitFor(
      () => ev(() => document.querySelectorAll('[data-edge-broken="true"]').length === 0),
      6000,
      '拆环后断边标记消失',
    )
  })

  await t('t71 点亮提示：前序全部发布 → 图节点一次性光晕（不改写卡片数据）', async () => {
    const p1 = await api('PATCH', `/boards/${relId}/items/e2e-c10`, { pre_ids: ['e2e-c09'] }, relToken.v)
    eq(p1.status, 200, 'PATCH c10 pre_ids=[c09]')
    await waitFor(
      () => ev(() => !!document.querySelector('[data-graph-edge="e2e-c09→e2e-c10"]')),
      9000,
      '新边 c09→c10 轮询入图',
    )
    ok(
      !(await ev(() => document.querySelector('[data-graph-node="e2e-c10"]')?.className.includes('graph-lit'))),
      '前序未发布不点亮',
    )
    const p2 = await api('PATCH', `/boards/${relId}/items/e2e-c09`, { status: '已发布' }, relToken.v)
    eq(p2.status, 200, 'PATCH c09 已发布')
    await waitFor(
      () => ev(() => document.querySelector('[data-graph-node="e2e-c10"]')?.className.includes('graph-lit') ?? false),
      9000,
      '前序全部发布 → 点亮光晕',
    )
    await waitFor(
      () => ev(() => !document.querySelector('[data-graph-node="e2e-c10"]')?.className.includes('graph-lit')),
      6000,
      '光晕一次性（1.3s 后消退）',
    )
    const d71 = await storedDoc(relId)
    ok(d71 && !('dimmed' in (d71.items.find((i) => i.id === 'e2e-c10') ?? {})), '点亮不改写卡片数据')
  })

  await t('t72 删卡级联：删除被引用卡 → 所有 pre/post 引用同步剔除', async () => {
    const p1 = await api('PATCH', `/boards/${relId}/items/e2e-c13`, { pre_ids: ['e2e-c12'] }, relToken.v)
    eq(p1.status, 200, 'PATCH c13 pre_ids=[c12]')
    await waitFor(async () => {
      const d = await storedDoc(relId)
      return d?.items.find((i) => i.id === 'e2e-c13')?.pre_ids?.includes('e2e-c12')
    }, 9000, 'c13 前序 c12 轮询落盘')
    // 切回时间线走 UI 主路径删除 c12
    await ev(() => document.querySelector('[data-view-tab="timeline"]')?.click())
    await waitFor(async () => (await colCount()) === 61, 6000, '切回时间线视图')
    ok(await ev(() => !location.hash.includes('view=graph')), 'hash 回到时间线')
    await ev(() => {
      const el = [...document.querySelectorAll('.h-full.overflow-auto [data-card-title]')].find(
        (p) => p.textContent === 'E2E 卡 12',
      )
      el?.closest('.group')?.querySelector('button[aria-label="删除卡片"]')?.click()
    })
    await waitFor(async () => {
      const d = await storedDoc(relId)
      const c13 = d?.items.find((i) => i.id === 'e2e-c13')
      return d && !d.items.some((i) => i.id === 'e2e-c12') && !(c13?.pre_ids ?? []).includes('e2e-c12')
    }, 9000, '删卡级联：c12 移除 + c13.pre_ids 剔除')
  })

  await t('t73 未连线暂存带：折叠计数 → 展开 → 双向拖线建边 → 升入分层图', async () => {
    // 此时关系：c05→c06、c06→c08、c09→c10（c12 已删）→ 已连线 5 卡，孤立卡 8 张
    await ev(() => document.querySelector('[data-view-tab="graph"]')?.click())
    await waitFor(() => ev(() => !!document.querySelector('[data-graph-view]')), 6000, '关系视图渲染')
    // 折叠态：只显计数，不列卡
    const toggleText = await ev(() => document.querySelector('[data-stage-toggle]')?.textContent ?? '')
    ok(toggleText.includes('未连线卡片 (8)'), `折叠计数正确（${toggleText.trim().slice(0, 20)}）`)
    ok(!(await ev(() => !!document.querySelector('[data-stage-list]'))), '默认折叠不列出卡片')
    // 展开：8 张孤立卡横排
    await ev(() => document.querySelector('[data-stage-toggle]')?.click())
    await waitFor(
      () => ev(() => document.querySelectorAll('[data-stage-card]').length === 8),
      4000,
      '展开列出 8 张孤立卡',
    )
    // 暂存卡点击开详情
    await ev(() => document.querySelector('[data-stage-card="e2e-c07"]')?.click())
    await waitFor(() => ev(() => !!document.querySelector('[data-slot="dialog-content"]')), 4000, '暂存卡开详情')
    await closeDialog()

    // 暂存卡 → 图节点拖线（方向规则：拖出方=前序，落点=后续）：c07 → c06
    const geo1 = await ev(() => {
      const from = document.querySelector('[data-stage-card="e2e-c07"]')
      const to = document.querySelector('[data-graph-node="e2e-c06"]')
      const h = from?.querySelector('[data-edge-handle]')
      if (!from || !to || !h) return null
      const hr = h.getBoundingClientRect()
      const tr = to.getBoundingClientRect()
      return {
        hx: hr.left + hr.width / 2,
        hy: hr.top + hr.height / 2,
        tx: tr.left + tr.width / 2,
        ty: tr.top + tr.height / 2,
      }
    })
    ok(geo1, '暂存卡/目标节点坐标就绪')
    await page.mouse.move(geo1.hx, geo1.hy)
    await sleep(120)
    await page.mouse.down()
    for (let i = 1; i <= 6; i += 1) {
      await page.mouse.move(geo1.hx + ((geo1.tx - geo1.hx) * i) / 6, geo1.hy + ((geo1.ty - geo1.hy) * i) / 6)
      await sleep(40)
    }
    await page.mouse.up()
    await waitFor(async () => {
      const d = await storedDoc(relId)
      return d?.items.find((i) => i.id === 'e2e-c06')?.pre_ids?.includes('e2e-c07')
    }, 6000, '暂存卡→节点建边落盘（c07 为 c06 前序）')
    // 升入分层图 + 离开暂存带
    await waitFor(() => ev(() => !!document.querySelector('[data-graph-node="e2e-c07"]')), 4000, 'c07 升入分层图')
    await waitFor(
      () => ev(() => document.querySelector('[data-stage-toggle]')?.textContent?.includes('未连线卡片 (7)') ?? false),
      4000,
      '暂存带计数降为 7',
    )
    ok(await ev(() => !!document.querySelector('[data-graph-edge="e2e-c07→e2e-c06"]')), '新边 c07→c06 渲染')

    // 反向：图节点 → 暂存卡拖线：c05（拖出=前序）→ c04（落点=后续）
    const geo2 = await ev(() => {
      const from = document.querySelector('[data-graph-node="e2e-c05"]')
      const to = document.querySelector('[data-stage-card="e2e-c04"]')
      const h = from?.querySelector('[data-edge-handle]')
      if (!from || !to || !h) return null
      const hr = h.getBoundingClientRect()
      const tr = to.getBoundingClientRect()
      return {
        hx: hr.left + hr.width / 2,
        hy: hr.top + hr.height / 2,
        tx: tr.left + tr.width / 2,
        ty: tr.top + hr.height / 2,
      }
    })
    ok(geo2, '节点/目标暂存卡坐标就绪')
    await page.mouse.move(geo2.hx, geo2.hy)
    await sleep(120)
    await page.mouse.down()
    for (let i = 1; i <= 6; i += 1) {
      await page.mouse.move(geo2.hx + ((geo2.tx - geo2.hx) * i) / 6, geo2.hy + ((geo2.ty - geo2.hy) * i) / 6)
      await sleep(40)
    }
    await page.mouse.up()
    await waitFor(async () => {
      const d = await storedDoc(relId)
      return d?.items.find((i) => i.id === 'e2e-c04')?.pre_ids?.includes('e2e-c05')
    }, 6000, '节点→暂存卡建边落盘（c05 为 c04 前序）')
    await waitFor(() => ev(() => !!document.querySelector('[data-graph-node="e2e-c04"]')), 4000, 'c04 升入分层图')
  })

  // 清掉全部测试板（不留测试数据；产品板已被 t53 删除）
  for (const [id, pw] of [
    [boardId, MAIN_PASS],
    [migId, MAIN_PASS],
    [relId, MAIN_PASS],
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
