#!/usr/bin/env node
/**
 * 开发双进程启动器（v15 起；v19 分包路径适配）：一条 `npm run dev` 同时起
 *   1. API server（packages/server/index.mjs，端口 API_PORT，默认 8787）
 *   2. vite dev server（cwd = web/，转发 CLI 的 --host/--port 等全部参数）
 * 退出时两个进程一起杀（SIGINT/SIGTERM/父进程退出均兜底）。
 *
 * Kimi Work 预览：`npm run dev -- --host localhost --port 7100 --strictPort`
 * 的参数会原样转发给 vite；API server 端口不冲突（8787）。
 */
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const WEB = path.join(ROOT, 'web')
const API_PORT = process.env.API_PORT || '8787'
const VITE_BIN = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js')
const SERVER_BIN = path.join(ROOT, 'packages', 'server', 'index.mjs')

const children = []
let shuttingDown = false

function start(name, args, cwd = ROOT, env = {}) {
  const child = spawn(process.execPath, args, {
    cwd,
    stdio: 'inherit',
    env: { ...process.env, API_PORT: API_PORT, ...env },
  })
  child.on('exit', (code, signal) => {
    if (shuttingDown) return
    console.log(`[dev] ${name} 退出（code=${code} signal=${signal}），一并关闭另一进程`)
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
start('vite', [VITE_BIN, ...process.argv.slice(2)], WEB)
