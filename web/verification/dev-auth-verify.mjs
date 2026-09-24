#!/usr/bin/env node
/**
 * dev 栈（npm run dev 自带 mock OAuth :5190 --jwt）体验验证（一次性脚本，非 e2e 回归）：
 * 打已经起好的 :7100 栈（本脚本不起/杀任何进程），验证视觉 A 期新功能在本地可见：
 *   ① 登录 → mock authorize 302 回跳 → 登录态首页
 *   ② 新建「dev 体验板」进板 → 首次全量 GET 后成员自登记：成员管理里「本地体验」带 ✓
 *   ③ 「+ 空卡片」发评论 → 评论作者自动署名「本地体验」（JWT user_name，非自报）
 *   ④ 负责人下拉顶部出现「（本人）」条目（user_id=9001 命中当前登录用户）
 * 产物：/Users/linan/Documents/Kimi/Workspaces/Timeline/shots-visual-a/dev-0{1..4}-*.png（1440×900 @2x）
 */
import path from 'node:path'
import puppeteer from 'puppeteer-core'

const WEB = 'http://127.0.0.1:7100'
const OUT = '/Users/linan/Documents/Kimi/Workspaces/Timeline/shots-visual-a'
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const BOARD_NAME = 'dev 体验板'
const BOARD_PASS = 'dev-experience-pass'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
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

  // ① 登录门 → mock 登录 → 登录态首页
  await page.goto(`${WEB}/`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => !!document.querySelector('[data-oauth-login]'), { timeout: 15000 })
  await sleep(500)
  await shot('dev-01-login.png')
  check('dev-01 登录门', true)

  await page.evaluate(() => document.querySelector('[data-oauth-login]')?.click())
  await page.waitForFunction(() => !!document.querySelector('[data-home]') && !document.querySelector('[data-auth-gate]'), {
    timeout: 20000,
  })
  check('mock authorize 302 回跳 → 登录态首页', true)

  // ② 新建看板 → 进板 → 等首次全量 GET + 成员自登记落定
  await page.type('[data-create-name]', BOARD_NAME)
  await page.type('[data-create-password]', BOARD_PASS)
  await page.click('[data-create-btn]')
  await page.waitForSelector('[data-theme-toggle]', { timeout: 15000 })
  // 自登记在首次全量 GET 落定后触发一次（change-set 写路径），轮询成员目录而不是盲等
  await page.waitForFunction(
    () => document.querySelector('[data-members-btn]') && !document.querySelector('[data-auth-gate]'),
    { timeout: 10000 },
  )
  await sleep(2500) // 等自登记 change-set commit 落定（轮询套用快照）
  await page.click('[data-members-btn]')
  await page.waitForSelector('[data-members-dialog]', { timeout: 8000 })
  // 自登记可能晚一拍到：最多再等 10s，直到目录里出现「本地体验」
  let memberInfo = null
  for (let i = 0; i < 20; i++) {
    memberInfo = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('[data-member-row]')]
      const self = rows.find((r) => r.textContent.includes('本地体验'))
      return self ? { found: true, hasCheck: self.textContent.includes('✓'), text: self.textContent.trim(), total: rows.length } : { found: false, total: rows.length }
    })
    if (memberInfo.found) break
    await sleep(500)
  }
  check('dev-02 成员自登记：目录出现「本地体验」', !!memberInfo?.found, JSON.stringify(memberInfo))
  check('dev-02 自登记成员带 ✓ 认证标记', !!memberInfo?.hasCheck)
  await sleep(400)
  await shot('dev-02-member-registered.png')
  await page.keyboard.press('Escape')
  await sleep(500)

  // ③ 「+ 空卡片」→ 起标题 → 发评论 → 作者自动署名「本地体验」
  await page.evaluate(() => {
    ;[...document.querySelectorAll('button')].find((b) => b.textContent.includes('空卡片') && b.closest('header, [class*="topbar"], body'))?.click()
  })
  await page.waitForFunction(() => !!document.querySelector('[data-comments-input]'), { timeout: 8000 })
  await sleep(400)
  await page.keyboard.type('dev 体验卡')
  await page.keyboard.press('Enter')
  await sleep(600)
  await page.evaluate(() => {
    const el = document.querySelector('[data-comments-input]')
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
    setter.call(el, '验证 JWT 自动署名：本条不应需要自报姓名')
    el.dispatchEvent(new Event('input', { bubbles: true }))
    document.querySelector('[data-comments-send]')?.click()
  })
  await page.waitForFunction(() => document.querySelectorAll('[data-comments-item]').length === 1, { timeout: 6000 })
  const author = await page.evaluate(() => document.querySelector('[data-comments-author]')?.textContent?.trim() ?? '')
  check('dev-03 评论作者自动署名「本地体验」', author === '本地体验', `实际="${author}"`)
  await sleep(300)
  await shot('dev-03-comment-author.png')

  // ④ 负责人下拉：本人条目置顶且带「（本人）」
  await page.evaluate(() => document.querySelector('[data-edit-field="content_owner_id"]')?.click())
  await page.waitForSelector('select[data-edit-input="content_owner_id"]', { timeout: 6000 })
  const options = await page.evaluate(() =>
    [...document.querySelectorAll('select[data-edit-input="content_owner_id"] option')].map((o) => o.textContent.trim()),
  )
  const selfIdx = options.findIndex((t) => t.includes('（本人）'))
  check('dev-04 负责人下拉出现「（本人）」条目', selfIdx !== -1, JSON.stringify(options))
  check('dev-04 「（本人）」置顶（仅次于「未分配」）', selfIdx === 1, `index=${selfIdx}`)
  check('dev-04 本人条目即「本地体验」', selfIdx !== -1 && options[selfIdx].includes('本地体验'))
  // 截图可见化：原生 select 弹层截不到，临时展开 size 让选项内联渲染（截完即关弹窗，不改数据）
  await page.evaluate(() => {
    const sel = document.querySelector('select[data-edit-input="content_owner_id"]')
    sel.size = Math.min(sel.options.length, 6)
  })
  await sleep(300)
  await shot('dev-04-owner-self.png')
  await page.keyboard.press('Escape')
  await sleep(400)

  check('无页面运行时错误', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '))
} finally {
  if (browser) await browser.close().catch(() => {})
}

const failed = checks.filter(([, ok]) => !ok)
console.log(`\n[dev-auth-verify] ${checks.length - failed.length} PASS / ${failed.length} FAIL`)
process.exit(failed.length ? 1 : 0)
