#!/usr/bin/env node
/**
 * OAuth Phase 0 手工/视觉冒烟（独立于 e2e 套件）：
 *   起 mock Auth（:5196，进程内）+ 真实 API server（:5195，独立 tmp sqlite）
 *   + vite（:5197，API_PORT=5195 反代、VITE_AUTH_ORIGIN=http://127.0.0.1:5196），
 *   驱动本机 Chrome：首页 → 截「登录门」→ 点「使用统一账号登录」走完整 mock 授权流
 *   （authorize 302 → callback → code exchange）→ 回落首页 → 截「看板列表」。
 *
 * 运行：node verification/oauth-smoke.mjs
 * 产物：verification/oauth-smoke-gate.png / oauth-smoke-home.png
 * 端口纪律：5195/5196/5197 本脚本独占（被占直接退出）；跑完杀进程组 + 删 tmp sqlite。
 */
import { spawn } from 'node:child_process'
import { createWriteStream, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import puppeteer from 'puppeteer-core'
import { getMockOauthStats, startMockOauth } from './mock-oauth.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const REPO_ROOT = path.resolve(ROOT, '..')
const VDIR = path.join(ROOT, 'verification')
const API_PORT = 5195
const MOCK_PORT = 5196
const WEB_PORT = 5197
const WEB = `http://localhost:${WEB_PORT}`
const DB = path.join(VDIR, 'tmp-oauth-smoke.sqlite')
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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

function killProcGroup(p) {
  if (!p || p.killed) return
  try {
    process.kill(-p.pid, 'SIGKILL')
  } catch {
    try {
      p.kill('SIGKILL')
    } catch {
      // 已退出
    }
  }
}

let apiProc = null
let webProc = null
let mockServer = null
let browser = null

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
  if (mockServer) {
    try {
      await new Promise((resolve) => mockServer.close(resolve))
    } catch {
      // ignore
    }
  }
  await sleep(300)
  for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) rmSync(f, { force: true })
}

let exitCode = 0
try {
  for (const p of [API_PORT, MOCK_PORT, WEB_PORT]) {
    if (await portBusy(p)) throw new Error(`端口 ${p} 被占用，请先释放再跑冒烟`)
  }
  for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) rmSync(f, { force: true })

  mockServer = await startMockOauth(MOCK_PORT)
  apiProc = spawn(process.execPath, [path.join(REPO_ROOT, 'packages/server/index.mjs')], {
    cwd: REPO_ROOT,
    detached: true,
    env: { ...process.env, API_PORT: String(API_PORT), BOARD_DB: DB, BOARD_SECRET: 'oauth-smoke-secret' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  apiProc.stdout.pipe(createWriteStream(path.join(VDIR, 'oauth-smoke-api.log')))
  apiProc.stderr.pipe(createWriteStream(path.join(VDIR, 'oauth-smoke-api.log')))
  webProc = spawn(
    process.execPath,
    [path.join(REPO_ROOT, 'node_modules/vite/bin/vite.js'), '--port', String(WEB_PORT), '--strictPort'],
    {
      cwd: ROOT,
      detached: true,
      env: { ...process.env, API_PORT: String(API_PORT), VITE_AUTH_ORIGIN: `http://127.0.0.1:${MOCK_PORT}` },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  webProc.stdout.pipe(createWriteStream(path.join(VDIR, 'oauth-smoke-web.log')))
  webProc.stderr.pipe(createWriteStream(path.join(VDIR, 'oauth-smoke-web.log')))
  await waitHttp(`http://localhost:${API_PORT}/api/health`)
  await waitHttp(`${WEB}/`)
  console.log(`[smoke] API :${API_PORT} + mock Auth :${MOCK_PORT} + vite :${WEB_PORT} 已就绪`)

  browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--disable-gpu', '--hide-scrollbars', '--window-size=1600,900'],
    defaultViewport: { width: 1600, height: 900 },
  })
  const page = await browser.newPage()
  page.on('pageerror', (e) => console.error('  [pageerror]', String(e).slice(0, 200)))

  // 1. 未登录：全站登录门
  await page.goto(`${WEB}/`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => !!document.querySelector('[data-oauth-login]'), { timeout: 10000 })
  await sleep(400)
  await page.screenshot({ path: path.join(VDIR, 'oauth-smoke-gate.png') })
  console.log('[smoke] 登录门截图 → oauth-smoke-gate.png')

  // 2. 点登录 → mock authorize 302 → callback → exchange → 回落首页
  await page.evaluate(() => document.querySelector('[data-oauth-login]')?.click())
  await page.waitForFunction(
    () =>
      !!document.querySelector('[data-home]') &&
      !document.querySelector('[data-auth-gate]') &&
      !document.querySelector('[data-oauth-callback]'),
    { timeout: 20000 },
  )
  const stats = getMockOauthStats()
  if (stats.authorize !== 1 || stats.token !== 1) throw new Error(`mock 计数异常：${JSON.stringify(stats)}`)
  const url = page.url()
  if (/[?&](code|state)=/.test(url)) throw new Error(`地址栏残留 code/state：${url}`)
  await sleep(600)
  await page.screenshot({ path: path.join(VDIR, 'oauth-smoke-home.png') })
  console.log('[smoke] 登录后首页截图 → oauth-smoke-home.png')
  console.log(`[smoke] PASS（authorize=${stats.authorize} token=${stats.token}，落点 ${url}）`)
} catch (e) {
  console.error('[smoke] FAIL：', e instanceof Error ? e.message : e)
  exitCode = 1
} finally {
  await teardown()
}
process.exit(exitCode)
