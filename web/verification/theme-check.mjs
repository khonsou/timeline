#!/usr/bin/env node
/**
 * v20 暗色主题截图验收（一次性脚本，非 e2e 回归；按任务 brief 产出）：
 *   自起 API :5195（临时库 /tmp，用完即删）+ vite :5196，无头 Chrome 走完整 UI 流程：
 *   预置 localStorage 暗色 → 首页 → 新建看板 → 导入卡片 → 暗色看板 → 刷新验证持久化
 *   → 详情弹窗 → 切亮色回归对照 → 杀净两个进程组并确认端口释放。
 * 产出（web/verification/）：theme-dark-home.png / theme-dark-board.png /
 *   theme-dark-detail.png / theme-light-board.png
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import puppeteer from 'puppeteer-core'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)))
const API_PORT = 5195
const VITE_PORT = 5196
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const TMP = mkdtempSync(path.join(tmpdir(), 'theme-check-'))

const pad = (n) => String(n).padStart(2, '0')
const dayKey = (offset, hhmm) => {
  const d = new Date()
  d.setDate(d.getDate() + offset)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${hhmm}`
}

// 覆盖 5 种类型徽章 / 已发布带指标 / 待发布 / 双负责人 / 备注，分布在 ±3 天
const ITEMS = [
  { title: '暗色验收 · 图文稿', type: '图文', publish_at: dayKey(-2, '09:00'), status: '已发布', roi: 3.3, propagation_4h: 1280, engagement_4h: 342, content_owner: '林晓', delivery_owner: '陈远', comment: '已发布带指标，验证 KPI 配色' },
  { title: '暗色验收 · 短视频', type: '短视频', publish_at: dayKey(-1, '10:30'), status: '待执行', content_owner: '陈远', comment: '' },
  { title: '暗色验收 · 音频节目', type: '音频', publish_at: dayKey(0, '08:00'), status: '已发布', roi: 1.8, propagation_4h: 860, engagement_4h: 210, content_owner: '林晓', delivery_owner: '林晓', comment: '今天列应有内容' },
  { title: '暗色验收 · 直播预告', type: '直播', publish_at: dayKey(0, '20:00'), status: '待发布', content_owner: '赵六', comment: '待发布卡指标恒空' },
  { title: '暗色验收 · 数据周报', type: '数据', publish_at: dayKey(1, '09:30'), status: '待执行', delivery_owner: '陈远', comment: '备注文字可读性检查' },
  { title: '暗色验收 · 复盘图文', type: '图文', publish_at: dayKey(2, '14:00'), status: '待发布', content_owner: '林晓', comment: '' },
  { title: '暗色验收 · 花絮视频', type: '短视频', publish_at: dayKey(3, '11:00'), status: '待执行', content_owner: '赵六', delivery_owner: '陈远', comment: '' },
]
const ITEMS_FILE = path.join(TMP, 'items.json')
writeFileSync(ITEMS_FILE, JSON.stringify(ITEMS, null, 2))

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
      process.kill(-c.pid, 'SIGKILL') // 负 pid = 整组
    } catch {}
  }
}
process.on('exit', killAll)

async function waitReady(url, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const r = await fetch(url)
      if (r.ok) return
    } catch {}
    if (Date.now() > deadline) throw new Error(`等待就绪超时: ${url}`)
    await new Promise((r) => setTimeout(r, 300))
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const checks = []
const check = (name, ok, extra = '') => {
  checks.push([name, ok])
  console.log(`${ok ? '✓' : '✗'} ${name}${extra ? ` —— ${extra}` : ''}`)
}

let browser
try {
  start('api', [path.join(ROOT, 'packages/server/index.mjs')], ROOT, {
    API_PORT: String(API_PORT),
    BOARD_DB: path.join(TMP, 'boards.sqlite'),
    BOARD_SECRET: 'theme-check-secret',
  })
  start('vite', [path.join(ROOT, 'node_modules/vite/bin/vite.js'), '--port', String(VITE_PORT), '--strictPort'], path.join(ROOT, 'web'), {
    API_PORT: String(API_PORT),
  })
  await waitReady(`http://localhost:${API_PORT}/api/boards`)
  await waitReady(`http://localhost:${VITE_PORT}/`)

  browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--window-size=1440,900', '--force-color-profile=srgb'],
  })
  const page = await browser.newPage()
  await page.setViewport({ width: 1440, height: 900 })
  const pageErrors = []
  page.on('pageerror', (e) => pageErrors.push(String(e)))
  // 截图前确保 localStorage 已是暗色：每个文档脚本运行前写入
  await page.evaluateOnNewDocument(() => {
    try {
      localStorage.setItem('timeline-theme', 'dark')
    } catch {}
  })

  // 1) 首页（暗色）
  await page.goto(`http://localhost:${VITE_PORT}/`, { waitUntil: 'networkidle0' })
  await page.waitForSelector('[data-home]')
  await sleep(400)
  await page.screenshot({ path: path.join(OUT, 'theme-dark-home.png') })
  check('首页暗色加载', await page.evaluate(() => document.documentElement.classList.contains('dark')))

  // 2) 新建看板（创建即自动持证进板）
  await page.type('[data-create-name]', '暗色主题验收板')
  await page.type('[data-create-password]', 'theme-check')
  await page.click('[data-create-btn]')
  await page.waitForSelector('[data-theme-toggle]', { timeout: 15000 })
  await sleep(600)

  // 3) 导入验收卡片
  const input = await page.$('[data-import-input]')
  await input.uploadFile(ITEMS_FILE)
  await sleep(1200) // 等导入 + 结果弹窗
  await page.keyboard.press('Escape')
  await sleep(500)
  const cardCount = await page.evaluate(() => document.body.innerText.match(/共\s*(\d+)\s*张卡片/)?.[1] ?? '0')
  check('导入 7 张验收卡', cardCount === '7', `顶栏计数=${cardCount}`)

  // 4) 暗色看板（回到今天，含卡片 / minimap / 顶栏）
  const isDark = await page.evaluate(() => document.documentElement.classList.contains('dark'))
  if (!isDark) await page.click('[data-theme-toggle]') // 兜底：预置未生效时切到暗色
  await page.evaluate(() => {
    const btns = [...document.querySelectorAll('button')]
    btns.find((b) => b.textContent.includes('回到今天'))?.click()
  })
  await sleep(800)
  await page.screenshot({ path: path.join(OUT, 'theme-dark-board.png') })
  check('暗色看板截图', true)

  // 5) 刷新持久化：重载后仍应为暗色
  await page.reload({ waitUntil: 'networkidle0' })
  await sleep(800)
  check(
    '刷新后暗色保持（localStorage 持久化）',
    await page.evaluate(
      () =>
        document.documentElement.classList.contains('dark') &&
        localStorage.getItem('timeline-theme') === 'dark',
    ),
  )

  // 6) 详情弹窗（暗色）：点击导入的卡片标题
  const opened = await page.evaluate(() => {
    const nodes = [...document.querySelectorAll('div, span, p')]
    const el = nodes.find((n) => n.children.length === 0 && n.textContent.trim() === '暗色验收 · 图文稿')
    if (!el) return false
    ;(el.closest('[draggable="true"]') ?? el).dispatchEvent(new MouseEvent('click', { bubbles: true }))
    el.click()
    return true
  })
  await sleep(800)
  const dialogVisible = (await page.$('[role="dialog"]')) !== null
  check('详情弹窗打开', opened && dialogVisible)
  await page.screenshot({ path: path.join(OUT, 'theme-dark-detail.png') })
  await page.keyboard.press('Escape')
  await sleep(400)

  // 7) 亮色回归对照
  await page.click('[data-theme-toggle]')
  await sleep(500)
  check(
    '切换回亮色',
    await page.evaluate(
      () =>
        !document.documentElement.classList.contains('dark') &&
        localStorage.getItem('timeline-theme') === 'light',
    ),
  )
  await page.evaluate(() => {
    const btns = [...document.querySelectorAll('button')]
    btns.find((b) => b.textContent.includes('回到今天'))?.click()
  })
  await sleep(600)
  await page.screenshot({ path: path.join(OUT, 'theme-light-board.png') })

  check('无页面运行时错误', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '))
} catch (e) {
  check(`流程异常: ${e instanceof Error ? e.message : String(e)}`, false)
} finally {
  if (browser) await browser.close().catch(() => {})
  killAll()
  await sleep(500)
  rmSync(TMP, { recursive: true, force: true })
}

// 端口释放确认
let portsFree = true
for (const p of [API_PORT, VITE_PORT]) {
  try {
    await fetch(`http://localhost:${p}/`)
    portsFree = false
  } catch {}
}
check('5195/5196 进程组杀净、端口释放', portsFree)

const failed = checks.filter(([, ok]) => !ok)
console.log(`\n[theme-check] ${checks.length - failed.length} PASS / ${failed.length} FAIL`)
process.exit(failed.length ? 1 : 0)
