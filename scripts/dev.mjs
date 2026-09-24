#!/usr/bin/env node
/**
 * 开发三进程启动器（v15 起；v19 分包路径适配；视觉 A 期起追加 mock Auth）：一条 `npm run dev` 同时起
 *   1. API server（packages/server/index.mjs，端口 API_PORT，默认 8787）
 *   2. vite dev server（cwd = web/，转发 CLI 的 --host/--port 等全部参数）
 *   3. mock OAuth（web/verification/mock-oauth.mjs，:5190 --jwt）——本地体验评论署名
 *      与成员自登记（假 JWT 带 user_name/user_id）；同时给 vite 注入
 *      VITE_AUTH_ORIGIN=http://127.0.0.1:5190。
 *   REAL_AUTH=1 时不起 mock、不注入 VITE_AUTH_ORIGIN，回退真实 auth.angrymiao.com。
 * mock 是「可选」进程：启动失败（如 5190 被另一个 dev 实例占用）只告警不杀全栈，
 * 「任一退出全杀」逻辑对它豁免；API/vite 任一退出仍全栈关闭。
 * 退出时所有子进程一起杀（SIGINT/SIGTERM/父进程退出均兜底）。
 *
 * Kimi Work 预览：`npm run dev -- --host localhost --port 7100 --strictPort`
 * 的参数会原样转发给 vite；API server 端口不冲突（8787），mock 不冲突（5190）。
 */
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const WEB = path.join(ROOT, 'web')
const API_PORT = process.env.API_PORT || '8787'
const VITE_BIN = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js')
const SERVER_BIN = path.join(ROOT, 'packages', 'server', 'index.mjs')
const MOCK_OAUTH_BIN = path.join(ROOT, 'web', 'verification', 'mock-oauth.mjs')
const MOCK_AUTH_PORT = process.env.MOCK_AUTH_PORT || '5190'
const REAL_AUTH = process.env.REAL_AUTH === '1'

const children = []
let shuttingDown = false

function start(name, args, cwd = ROOT, env = {}, { optional = false } = {}) {
  const child = spawn(process.execPath, args, {
    cwd,
    stdio: 'inherit',
    env: { ...process.env, API_PORT: API_PORT, ...env },
  })
  child.on('error', (err) => {
    // spawn 失败（如可执行文件缺失）：可选进程只告警；必需进程照旧由 exit 兜底
    console.warn(`[dev] ⚠ ${name} 启动失败：${err.message}${optional ? '（可选进程，继续运行）' : ''}`)
  })
  child.on('exit', (code, signal) => {
    if (shuttingDown) return
    if (optional) {
      console.warn(`[dev] ⚠ ${name} 退出（code=${code} signal=${signal}）——可选进程，不杀全栈（端口被占？）`)
      return
    }
    console.log(`[dev] ${name} 退出（code=${code} signal=${signal}），一并关闭其余进程`)
    shutdown(code ?? 0)
  })
  children.push(child)
  return child
}

function killAll() {
  for (const c of children) {
    try {
      c.kill('SIGKILL')
    } catch {
      // 已退出
    }
  }
}

function shutdown(code = 0) {
  if (shuttingDown) return
  shuttingDown = true
  // dev 场景直接强杀：SIGTERM 对 vite 偶发不生效，kill 后立即 exit，
  // 避免 unref 定时器在事件循环清空后不执行导致子进程残留
  killAll()
  process.exit(code)
}

process.on('SIGINT', () => shutdown(130))
process.on('SIGTERM', () => shutdown(143))
// 兜底：父进程以任何方式退出（含未捕获异常）时，子进程一并带走
process.on('exit', killAll)

console.log(`[dev] API server → http://127.0.0.1:${API_PORT}（BOARD_DB=${process.env.BOARD_DB || 'packages/server/boards.sqlite'}）`)
start('api', [SERVER_BIN])
if (REAL_AUTH) {
  console.log('[dev] REAL_AUTH=1：不起 mock OAuth、不注入 VITE_AUTH_ORIGIN（前端走真实 auth.angrymiao.com）')
  start('vite', [VITE_BIN, ...process.argv.slice(2)], WEB)
} else {
  console.log(`[dev] mock OAuth → http://127.0.0.1:${MOCK_AUTH_PORT}（--jwt；启动失败仅告警不杀全栈）`)
  start('mock-auth', [MOCK_OAUTH_BIN, MOCK_AUTH_PORT, '--jwt'], ROOT, {}, { optional: true })
  start('vite', [VITE_BIN, ...process.argv.slice(2)], WEB, { VITE_AUTH_ORIGIN: `http://127.0.0.1:${MOCK_AUTH_PORT}` })
}
