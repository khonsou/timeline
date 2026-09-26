#!/usr/bin/env node
/**
 * E 期暗色死角补查（一次性）：toast pill 与 ImportResultDialog 的暗色渲染。
 * 复用「字体 B 期走查板」（shots-visual-e 已注入 8 卡）；暗色经 TopBar 开关原地切换。
 * toast：点卡片工具条「复制分享链接」触发；导入报告：input[type=file] 投喂 1 条 JSON。
 * 产物：/Users/linan/Documents/Kimi/Workspaces/Timeline/shots-visual-e/*.png
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import puppeteer from 'puppeteer-core'

const WEB = 'http://localhost:7100'
const OUT = '/Users/linan/Documents/Kimi/Workspaces/Timeline/shots-visual-e'
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const BOARD_NAME = '字体 B 期走查板'
const BOARD_PASS = 'visual-b-pass'

mkdirSync(OUT, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const checks = []
const check = (name, ok, extra = '') => {
  checks.push([name, ok])
  console.log(`${ok ? '✓' : '✗'} ${name}${extra ? ` —— ${extra}` : ''}`)
}

// 导入 fixture：1 条合法记录（字段口径同 docs/cli-import-guide）
const IMPORT_FILE = path.join(OUT, 'import-fixture.json')
writeFileSync(
  IMPORT_FILE,
  JSON.stringify([
    { id: 've-import-1', title: '暗色死角补查导入卡', type: '图文', publish_at: '2026-09-26T21:00', status: '待执行' },
  ]),
)

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

  await page.evaluateOnNewDocument(() => {
    try {
      localStorage.setItem('timeline-theme', 'dark')
    } catch {}
  })
  await page.goto(`${WEB}/`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => !!document.querySelector('[data-oauth-login]'), { timeout: 15000 })
  await page.evaluate(() => document.querySelector('[data-oauth-login]')?.click())
  await page.waitForFunction(() => !!document.querySelector('[data-board-table]'), { timeout: 20000 })
  await sleep(1800)
  await page.evaluate((name) => {
    const row = [...document.querySelectorAll('[data-board-row]')].find((r) => r.textContent.includes(name))
    row?.querySelector('[data-board-open]')?.click()
  }, BOARD_NAME)
  await page.waitForSelector('[data-gate-password]', { timeout: 15000 })
  await page.type('[data-gate-password]', BOARD_PASS)
  await page.click('[data-gate-submit]')
  await page.waitForSelector('[data-theme-toggle]', { timeout: 15000 })
  await page.waitForFunction(() => document.querySelectorAll('[data-card-title]').length >= 8, { timeout: 20000 })
  await page.waitForFunction(() => document.documentElement.classList.contains('dark'), { timeout: 5000 })

  // e-09 toast pill（暗）：复制分享链接 → toast 出现即截
  await page.evaluate(() => {
    const card = document.querySelector('[data-card-id]')
    card?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    card?.querySelector('[data-card-copy-link]')?.click()
  })
  await page.waitForSelector('[data-toast]', { timeout: 8000 })
  await sleep(300)
  await shot('e-09-toast-dark.png')
  const toastStyle = await page.evaluate(() => {
    const el = document.querySelector('[data-toast]')
    if (!el) return null
    const cs = getComputedStyle(el)
    return { bg: cs.backgroundColor, color: cs.color }
  })
  // 暗色翻转体系下 toast = 浅底深字（与 minimap tooltip 同模式）；只要不出现「白字落白底」即合格
  check('e-09 toast（暗）可读（底/字不同层级）', !!toastStyle && toastStyle.bg !== toastStyle.color, JSON.stringify(toastStyle))
  await page.waitForFunction(() => !document.querySelector('[data-toast]'), { timeout: 8000 })

  // e-10 导入报告弹窗（暗）：投喂 1 条 JSON 触发真实导入
  const input = await page.$('input[type=file]')
  await input.uploadFile(IMPORT_FILE)
  await page.waitForSelector('[data-import-report]', { timeout: 10000 })
  await sleep(600)
  await shot('e-10-import-dark.png')
  const importStyle = await page.evaluate(() => {
    const g = (el) => (el ? getComputedStyle(el).backgroundColor : null)
    const dlg = document.querySelector('[data-import-report]')
    return {
      dlgBg: g(dlg),
      imported: document.querySelector('[data-report-imported]')?.textContent,
      dark: document.documentElement.classList.contains('dark'),
    }
  })
  check('e-10 导入报告（暗）渲染成功', importStyle.dark && importStyle.imported === '1', JSON.stringify(importStyle))

  check('无页面运行时错误', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '))
} finally {
  if (browser) await browser.close().catch(() => {})
}

const failed = checks.filter(([, ok]) => !ok)
console.log(`\n[shots-visual-e-dark2] ${checks.length - failed.length} PASS / ${failed.length} FAIL → ${OUT}`)
process.exit(failed.length ? 1 : 0)
