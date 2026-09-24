#!/usr/bin/env node
/**
 * 视觉升级 D 期（品牌面）截图走查（一次性脚本，非 e2e 回归）：
 * 打已起好的 dev 栈（npm run dev 自带 mock OAuth :5190 --jwt；本脚本不起/杀任何进程）。
 * 无头 Chrome 1440×900 @2x，亮/暗双主题各截：登录门 / 首页 / 密码门（品牌面恒深色，
 * 两主题应渲染一致）+ 首页入场中间态一帧（d-00）。
 * 流程：Node 侧 API 建「品牌面 D 期走查板」→ 页面登录 → 首页点该行进密码门
 * （新建板不经 UI 建，页面会话无其 token，正好落到密码门）；暗色经 localStorage 预置 +
 * reload（会话随内存失效，正好先拍暗色登录门再重新登录）。
 * 断言：三页根容器在两主题下 backgroundColor 恒为 rgb(0,0,0)、功能卡恒为白容器。
 * 产物：/Users/linan/Documents/Kimi/Workspaces/Timeline/shots-visual-d/*.png
 */
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import puppeteer from 'puppeteer-core'

const API = 'http://127.0.0.1:8787'
const WEB = 'http://localhost:7100' // vite 绑定 localhost（::1）；勿用 127.0.0.1
const OUT = '/Users/linan/Documents/Kimi/Workspaces/Timeline/shots-visual-d'
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const BOARD_NAME = '品牌面 D 期走查板'
const BOARD_PASS = 'visual-d-pass'
const ANIMATION_SETTLE = 1800 // 错峰最后一拍 900ms + 800ms 时长，留 100ms 余量

mkdirSync(OUT, { recursive: true })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const checks = []
const check = (name, ok, extra = '') => {
  checks.push([name, ok])
  console.log(`${ok ? '✓' : '✗'} ${name}${extra ? ` —— ${extra}` : ''}`)
}

// 建走查板（Node 侧 API；页面会话不持有其 token → 点行即落密码门）
const createRes = await fetch(`${API}/api/boards`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name: BOARD_NAME, password: BOARD_PASS }),
})
if (createRes.status !== 201) throw new Error(`建板失败: ${createRes.status} ${await createRes.text()}`)
const { board_id: boardId } = await createRes.json()
console.log(`[shots] 已建「${BOARD_NAME}」 ${boardId}`)

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

  /** 品牌面锚定深色断言：根容器纯黑 + 功能卡白容器（两主题一致） */
  const assertBrandDark = async (tag, rootSel) => {
    const r = await page.evaluate((sel) => {
      const root = document.querySelector(sel)
      if (!root) return null
      const card = root.querySelector('.bg-white')
      return {
        rootBg: getComputedStyle(root).backgroundColor,
        cardBg: card ? getComputedStyle(card).backgroundColor : null,
        htmlDark: document.documentElement.classList.contains('dark'),
      }
    }, rootSel)
    check(
      `${tag} 恒深色锚定（黑底 + 白容器）`,
      !!r && r.rootBg === 'rgb(0, 0, 0)' && (r.cardBg === null || r.cardBg.startsWith('rgb(255, 255, 255')),
      JSON.stringify(r),
    )
  }

  const openBoardRow = () =>
    page.evaluate((name) => {
      const row = [...document.querySelectorAll('[data-board-row]')].find((r) => r.textContent.includes(name))
      row?.querySelector('[data-board-open]')?.click()
      return !!row
    }, BOARD_NAME)

  // ================= 亮主题（localStorage 预置 light） =================
  await page.evaluateOnNewDocument(() => {
    try {
      if (!localStorage.getItem('timeline-theme')) localStorage.setItem('timeline-theme', 'light')
    } catch {}
  })

  // 1) 登录门（亮主题下恒深色）
  await page.goto(`${WEB}/`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('[data-auth-gate]', { timeout: 15000 })
  await sleep(ANIMATION_SETTLE)
  await shot('d-01-gate-light.png')
  await assertBrandDark('d-01 登录门（亮主题）', '[data-auth-gate]')

  // 2) mock 登录 → 首页（先抓一帧入场中间态，再等落定截正式帧）
  await page.evaluate(() => document.querySelector('[data-oauth-login]')?.click())
  await page.waitForFunction(() => !!document.querySelector('[data-home]'), { timeout: 20000 })
  await sleep(550) // 眉题(300ms)已现、主标题(500ms)刚起——入场错峰中间态
  await shot('d-00-home-entering.png')
  await page.waitForFunction(() => !!document.querySelector('[data-board-table]'), { timeout: 15000 })
  await sleep(ANIMATION_SETTLE)
  await shot('d-02-home-light.png')
  await assertBrandDark('d-02 首页（亮主题）', '[data-home]')

  // 3) 点行走查板 → 密码门（亮）
  check('首页存在走查板行', await openBoardRow())
  await page.waitForSelector('[data-gate]', { timeout: 15000 })
  await sleep(ANIMATION_SETTLE)
  const gateName = await page.evaluate(() => document.querySelector('[data-gate-name]')?.textContent ?? '')
  check('密码门显示走查板名', gateName.includes(BOARD_NAME), gateName)
  await shot('d-03-password-light.png')
  await assertBrandDark('d-03 密码门（亮主题）', '[data-gate]')

  // ================= 暗主题（localStorage 预置 dark + 回首页重新载入；会话掉回登录门） =================
  // 注意必须先回 '/' 再重新载入：OAuth 登录回跳 return_to 取当前路径，停在 /b/:id 上登录会回密码门而非首页
  await page.evaluate(() => localStorage.setItem('timeline-theme', 'dark'))
  await page.goto(`${WEB}/`, { waitUntil: 'networkidle0' })
  await page.waitForSelector('[data-auth-gate]', { timeout: 15000 })
  await sleep(ANIMATION_SETTLE)
  await shot('d-04-gate-dark.png')
  await assertBrandDark('d-04 登录门（暗主题）', '[data-auth-gate]')

  // 5) 重新登录 → 首页（暗）
  await page.evaluate(() => document.querySelector('[data-oauth-login]')?.click())
  await page.waitForFunction(() => !!document.querySelector('[data-home]') && !!document.querySelector('[data-board-table]'), {
    timeout: 20000,
  })
  await sleep(ANIMATION_SETTLE)
  await shot('d-05-home-dark.png')
  await assertBrandDark('d-05 首页（暗主题）', '[data-home]')

  // 6) 密码门（暗）
  check('首页存在走查板行（暗）', await openBoardRow())
  await page.waitForSelector('[data-gate]', { timeout: 15000 })
  await sleep(ANIMATION_SETTLE)
  await shot('d-06-password-dark.png')
  await assertBrandDark('d-06 密码门（暗主题）', '[data-gate]')

  check('无页面运行时错误', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '))
} finally {
  if (browser) await browser.close().catch(() => {})
}

const failed = checks.filter(([, ok]) => !ok)
console.log(`\n[shots-visual-d] ${checks.length - failed.length} PASS / ${failed.length} FAIL → ${OUT}`)
process.exit(failed.length ? 1 : 0)
