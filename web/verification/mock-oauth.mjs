#!/usr/bin/env node
/**
 * OAuth mock server（angrymiao-auth 的最小替身；e2e 与手工冒烟专用）。
 *
 * 两种用法：
 *   ① e2e 进程内：import { startMockOauth, getMockOauthStats } from './mock-oauth.mjs'
 *      起在同一个 node 进程里，省一次 spawn；stats 直接进程内读取。
 *   ② 独立跑：node verification/mock-oauth.mjs [port]  （默认 5196；手工冒烟用，
 *      配合 vite 的 VITE_AUTH_ORIGIN=http://127.0.0.1:5196 与真实 API server）
 *
 * 端点（对齐 docs/oauth-auth-integration.md §4 的 Auth 侧契约）：
 *   GET  /oauth/authorize   校验 client_id/response_type/redirect_uri/state/PKCE 参数，
 *                           通过则 302 回 redirect_uri?code=mock-code-N&state=<回显>
 *   POST /api/oauth/token   校验 grant_type/client_id/code 前缀/code_verifier/redirect_uri，
 *                           通过则返回 mock access token（带 CORS：页面在 localhost、mock 在 127.0.0.1，跨源）
 *   GET  /__stats           返回 {authorize, token} 计数（断言「错误分支不调 token endpoint」用）
 *
 * 端口纪律：5196 为测试段独占（5195–5199；7100–7102 永远不碰）。
 */
import { createServer } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DEFAULT_PORT = 5196

const stats = { authorize: 0, token: 0 }
let codeSeq = 0

/** 读取当前计数快照（进程内 e2e 用；等价于 GET /__stats） */
export function getMockOauthStats() {
  return { ...stats }
}

function json(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
  })
  res.end(JSON.stringify(body))
}

/** 启动 mock，resolve 为 http.Server（调用方负责 close） */
export function startMockOauth(port = DEFAULT_PORT) {
  const server = createServer((req, res) => {
    const url = new URL(req.url || '/', `http://127.0.0.1:${port}`)

    // CORS 预检：token exchange 是跨源 POST（content-type: urlencoded 虽属简单请求，预检兜底）
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-allow-headers': 'content-type',
      })
      res.end()
      return
    }

    if (req.method === 'GET' && url.pathname === '/oauth/authorize') {
      const ok =
        url.searchParams.get('client_id') === 'timeline' &&
        url.searchParams.get('response_type') === 'code' &&
        !!url.searchParams.get('redirect_uri') &&
        !!url.searchParams.get('state') &&
        !!url.searchParams.get('code_challenge') &&
        url.searchParams.get('code_challenge_method') === 'S256'
      if (!ok) {
        json(res, 400, { error: 'invalid_request' })
        return
      }
      stats.authorize += 1
      codeSeq += 1
      const target = new URL(url.searchParams.get('redirect_uri'))
      target.searchParams.set('code', `mock-code-${codeSeq}`)
      target.searchParams.set('state', url.searchParams.get('state'))
      res.writeHead(302, { location: target.toString() })
      res.end()
      return
    }

    if (req.method === 'POST' && url.pathname === '/api/oauth/token') {
      let body = ''
      req.on('data', (chunk) => {
        body += chunk
      })
      req.on('end', () => {
        const p = new URLSearchParams(body)
        const ok =
          p.get('grant_type') === 'authorization_code' &&
          p.get('client_id') === 'timeline' &&
          (p.get('code') || '').startsWith('mock-code-') &&
          !!p.get('code_verifier') &&
          !!p.get('redirect_uri')
        if (!ok) {
          json(res, 400, { error: 'invalid_grant' })
          return
        }
        stats.token += 1
        json(res, 200, {
          access_token: 'mock-access-token',
          token_type: 'Bearer',
          expires_in: 86400,
          scope: 'profile phone',
        })
      })
      return
    }

    if (req.method === 'GET' && url.pathname === '/__stats') {
      json(res, 200, stats)
      return
    }

    json(res, 404, { error: 'not_found' })
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => resolve(server))
  })
}

// ---------------------------------------------------------------------------
// standalone：node verification/mock-oauth.mjs [port]
// ---------------------------------------------------------------------------
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const port = Number(process.argv[2]) || DEFAULT_PORT
  await startMockOauth(port)
  console.log(`[mock-oauth] listening on http://127.0.0.1:${port}（/oauth/authorize /api/oauth/token /__stats）`)
}
