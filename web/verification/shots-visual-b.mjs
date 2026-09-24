#!/usr/bin/env node
/**
 * 视觉升级 B 期（字体层）截图走查（一次性脚本，非 e2e 回归）：
 * 打已起好的 dev 栈（npm run dev 自带 mock OAuth :5190 --jwt；本脚本不起/杀任何进程），
 * 无头 Chrome 1440×900 @2x，亮/暗双主题各截：首页 / 看板主界面 / 卡片详情弹窗。
 * 看板数据：UI 建板后走 API 整板 PUT 注入 7 张验收卡（同 shots-visual-a 手法：
 * 按 publish_at 日期挂组，页面 5s 轮询自动套用，无需 reload——reload 会丢纯内存 OAuth 会话）。
 * 断言：document.fonts 确认 JetBrains Mono / Handjet 已加载（@font-face 接线验证）。
 * 产物：/Users/linan/Documents/Kimi/Workspaces/Timeline/shots-visual-b/*.png
 */
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import puppeteer from 'puppeteer-core'

const API = 'http://127.0.0.1:8787'
const WEB = 'http://localhost:7100' // vite 绑定 localhost（::1）；勿用 127.0.0.1
const OUT = '/Users/linan/Documents/Kimi/Workspaces/Timeline/shots-visual-b'
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
// 覆盖：已发布带指标（等宽数字节奏）/ 待发布 / 待执行 / 双负责人 / 备注；今天列 2 张（橙色 accent）。
const ITEMS = [
  { id: 'vb-0001', title: '字体走查 · 图文稿', type: '图文', publish_at: dayKey(-2, '09:00'), status: '已发布', roi: 3.3, propagation_4h: 1280, engagement_4h: 342, content_owner_id: 'M-9001', delivery_owner_id: 'M-9002', comment: '已发布带指标，验证等宽数字节奏' },
  { id: 'vb-0002', title: '字体走查 · 短视频', type: '视频', publish_at: dayKey(-1, '10:30'), status: '待执行', content_owner_id: 'M-9002', delivery_owner_id: '', comment: '' },
  { id: 'vb-0003', title: '字体走查 · 音频节目', type: '音频', publish_at: dayKey(0, '08:00'), status: '已发布', roi: 1.8, propagation_4h: 860, engagement_4h: 210, content_owner_id: 'M-9001', delivery_owner_id: 'M-9001', comment: '今天列已发布卡' },
  { id: 'vb-0004', title: '字体走查 · 直播预告', type: '直播', publish_at: dayKey(0, '20:00'), status: '待发布', content_owner_id: 'M-9003', delivery_owner_id: '', comment: '今天列待发布卡（指标恒空）' },
  { id: 'vb-0005', title: '字体走查 · 数据周报', type: '数据', publish_at: dayKey(1, '09:30'), status: '待执行', content_owner_id: '', delivery_owner_id: 'M-9002', comment: '中文正文应保持系统黑体、不拉字距' },
  { id: 'vb-0006', title: '字体走查 · 复盘图文', type: '图文', publish_at: dayKey(2, '14:00'), status: '待发布', content_owner_id: 'M-9001', delivery_owner_id: '', comment: '' },
  { id: 'vb-0007', title: '字体走查 · 花絮视频', type: '视频', publish_at: dayKey(3, '11:00'), status: '待执行', content_owner_id: 'M-9003', delivery_owner_id: 'M-9002', comment: '' },
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

  // ================= 亮主题 =================
  // 1) 登录 → 首页（亮）
  await page.goto(`${WEB}/`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => !!document.querySelector('[data-oauth-login]'), { timeout: 15000 })
  await page.evaluate(() => document.querySelector('[data-oauth-login]')?.click())
  await page.waitForFunction(() => !!document.querySelector('[data-home]') && !document.querySelector('[data-auth-gate]'), {
    timeout: 20000,
  })
  await sleep(1000)
  await shot('b-03-home-light.png')
  check('b-03 首页（亮）', !(await isDark()))

  // 2) 创建看板 → API 注入 7 张验收卡（等 5s 轮询套用，不 reload）
  await page.type('[data-create-name]', BOARD_NAME)
  await page.type('[data-create-password]', BOARD_PASS)
  await page.click('[data-create-btn]')
  await page.waitForSelector('[data-theme-toggle]', { timeout: 15000 })
  await sleep(600)
  const boardId = /\/b\/([0-9a-f]{16})/.exec(page.url())?.[1]
  const authRes = await api('POST', `/boards/${boardId}/auth`, { password: BOARD_PASS })
  if (authRes.status !== 200 || !authRes.body?.token) throw new Error(`看板 auth 失败: ${authRes.status}`)
  const token = authRes.body.token
  const cur = await api('GET', `/boards/${boardId}`, undefined, token)
  if (cur.status !== 200 || !cur.body?.doc) throw new Error(`读取看板 doc 失败: ${cur.status}`)
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
  check('API 整板注入 7 张验收卡', put.status === 200, `PUT=${put.status}`)
  await page.waitForFunction(
    () => document.querySelectorAll('[data-card-title]').length === 7 && /共\s*7\s*张卡片/.test(document.body.innerText),
    { timeout: 20000 },
  )
  // @font-face 接线断言：fonts.load 主动触发拉取（fonts.check 不会触发下载，懒加载下恒 false）
  const fonts = await page.evaluate(async () => {
    const [jbm, dot] = await Promise.all([
      document.fonts.load('16px "JetBrains Mono"', '0123456789'),
      document.fonts.load('16px "Handjet"', '0123456789'),
    ])
    return { jbm: jbm.length > 0, dot: dot.length > 0 }
  })
  check('JetBrains Mono / Handjet 已加载（fonts.load）', fonts.jbm && fonts.dot, JSON.stringify(fonts))
  await sleep(600)
  // font-dot 实锤：TopBar「共 N 张卡片」的 N computed font-family 含 Handjet，且走 font-variation-settings 定帧
  const dotBoard = await page.evaluate(() => {
    const el = [...document.querySelectorAll('.font-dot')][0]
    if (!el) return null
    const cs = getComputedStyle(el)
    return { fontFamily: cs.fontFamily, fvs: cs.fontVariationSettings, text: el.textContent }
  })
  check('font-dot 落在 TopBar 大数字（Handjet + 定帧）', !!dotBoard && dotBoard.fontFamily.includes('Handjet'), JSON.stringify(dotBoard))
  // font-mono 实锤：信息位 computed font-family 含 JetBrains Mono
  const monoCol = await page.evaluate(() => {
    const el = [...document.querySelectorAll('.font-mono')].map((n) => ({ t: n.textContent.trim().slice(0, 12), f: getComputedStyle(n).fontFamily }))[0]
    return el ?? null
  })
  check('font-mono 落在信息位（JetBrains Mono）', !!monoCol && monoCol.f.includes('JetBrains Mono'), JSON.stringify(monoCol))

  // 3) 看板主界面（亮）：TopBar font-dot 大数字 / 列头日期 font-mono / 卡片指标
  await backToToday()
  await sleep(800)
  await shot('b-01-board-light.png')
  check('b-01 看板主界面（亮）', true)

  // 4) 详情弹窗（亮）：指标区等宽数字 + 时间 + 标签
  check('打开详情弹窗（亮）', await openCard('字体走查 · 图文稿'))
  await page.waitForFunction(() => !!document.querySelector('[data-comments-input]'), { timeout: 8000 })
  await sleep(500)
  await shot('b-02-detail-light.png')
  check('b-02 详情弹窗（亮）', true)
  await page.keyboard.press('Escape')
  await sleep(300)
  await page.keyboard.press('Escape')
  await sleep(400)

  // ================= 暗主题 =================
  // TopBar 主题开关原地切暗（不 reload，保住纯内存 OAuth 会话）
  await page.click('[data-theme-toggle]')
  await page.waitForFunction(() => document.documentElement.classList.contains('dark'), { timeout: 5000 })
  await sleep(600)
  check('暗色切换生效', await isDark())
  await shot('b-04-board-dark.png')
  check('b-04 看板主界面（暗）', true)

  check('打开详情弹窗（暗）', await openCard('字体走查 · 图文稿'))
  await page.waitForFunction(() => !!document.querySelector('[data-comments-input]'), { timeout: 8000 })
  await sleep(500)
  await shot('b-05-detail-dark.png')
  check('b-05 详情弹窗（暗）', true)
  await page.keyboard.press('Escape')
  await sleep(300)
  await page.keyboard.press('Escape')
  await sleep(400)

  // 5) 首页（暗）：SPA 返回（data-back-home），不 reload
  await page.evaluate(() => document.querySelector('[data-back-home]')?.click())
  await page.waitForSelector('[data-home]', { timeout: 15000 })
  await sleep(1000)
  const homeState = await page.evaluate(() => ({
    table: !!document.querySelector('[data-board-table]'),
    rows: document.querySelectorAll('[data-board-row]').length,
    dark: document.documentElement.classList.contains('dark'),
  }))
  check('b-06 首页（暗）', homeState.table && homeState.rows >= 1 && homeState.dark, JSON.stringify(homeState))
  await shot('b-06-home-dark.png')

  check('无页面运行时错误', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '))
} finally {
  if (browser) await browser.close().catch(() => {})
}

const failed = checks.filter(([, ok]) => !ok)
console.log(`\n[shots-visual-b] ${checks.length - failed.length} PASS / ${failed.length} FAIL → ${OUT}`)
process.exit(failed.length ? 1 : 0)
