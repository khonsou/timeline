import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import test from 'node:test'

import { execute } from '../scripts/angrymiao-coin-cli.ts'

async function withApiServer(handler, run) {
  const requests = []
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1')
    requests.push({
      method: request.method,
      path: url.pathname,
      search: url.search,
      authorization: request.headers.authorization,
    })
    handler(request, response, url)
  })

  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  const baseUrl = `http://127.0.0.1:${address.port}`

  try {
    return await run(baseUrl, requests)
  } finally {
    server.close()
    await once(server, 'close')
  }
}

function sendJson(response, status, body) {
  const payload = JSON.stringify(body)
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(payload)
}

test('permission current-user calls the customer permission endpoint with bearer auth', async () => {
  await withApiServer((request, response, url) => {
    assert.equal(request.method, 'GET')
    assert.equal(url.pathname, '/api/permission/current-user')
    sendJson(response, 200, { permissions: ['task.read'] })
  }, async (baseUrl, requests) => {
    const result = await execute(
      ['--json', 'permission', 'current-user'],
      {
        ANGRYMIAO_COIN_CUSTOMER_BASE_URL: baseUrl,
        ANGRYMIAO_COIN_TOKEN: 'customer-token',
      },
    )

    assert.equal(result.exitCode, 0)
    assert.equal(result.payload.ok, true)
    assert.deepEqual(result.payload.data, { permissions: ['task.read'] })
    assert.equal(requests[0].authorization, 'Bearer customer-token')
    assert.equal(result.payload.meta.request.path, 'permission/current-user')
  })
})

test('tags list uses the admin endpoint and forwards repeated query options', async () => {
  await withApiServer((request, response, url) => {
    assert.equal(request.method, 'GET')
    assert.equal(url.pathname, '/api/tags')
    assert.equal(url.search, '?page_size=100&ordering=-id')
    sendJson(response, 200, { count: 1, results: [{ id: 9, name: '运营' }] })
  }, async (baseUrl, requests) => {
    const result = await execute(
      ['--json', '--admin-base-url', baseUrl, '--token', 'admin-token', 'tags', 'list', '--query', 'page_size=100', '--query', 'ordering=-id'],
      {},
    )

    assert.equal(result.exitCode, 0)
    assert.equal(result.payload.ok, true)
    assert.equal(requests[0].authorization, 'Bearer admin-token')
    assert.equal(result.payload.meta.service, 'admin')
    assert.deepEqual(result.payload.meta.request.params, { page_size: '100', ordering: '-id' })
  })
})

test('tags current-user calls the customer task-tag endpoint', async () => {
  await withApiServer((request, response, url) => {
    assert.equal(request.method, 'GET')
    assert.equal(url.pathname, '/api/task-tag')
    sendJson(response, 200, { count: 1, results: [{ id: 9, name: '运营', is_display: true }] })
  }, async (baseUrl, requests) => {
    const result = await execute(
      ['--json', '--customer-base-url', baseUrl, '--token', 'customer-token', 'tags', 'current-user'],
      {},
    )

    assert.equal(result.exitCode, 0)
    assert.equal(result.payload.ok, true)
    assert.equal(requests[0].path, '/api/task-tag')
    assert.equal(requests[0].authorization, 'Bearer customer-token')
    assert.equal(result.payload.meta.request.path, 'task-tag')
  })
})

test('protected commands stop before the network when token is missing', async () => {
  await withApiServer((_request, response) => {
    sendJson(response, 500, { message: 'must not be called' })
  }, async (baseUrl, requests) => {
    const result = await execute(
      ['--json', '--customer-base-url', baseUrl, 'permission', 'current-user'],
      {},
    )

    assert.equal(result.exitCode, 1)
    assert.equal(result.payload.ok, false)
    assert.equal(result.payload.status_code, 401)
    assert.equal(result.payload.error.code, 'auth_required')
    assert.deepEqual(requests, [])
  })
})

test('backend errors remain structured and include request metadata', async () => {
  await withApiServer((_request, response) => {
    sendJson(response, 403, { code: 'forbidden', message: '没有权限' })
  }, async (baseUrl) => {
    const result = await execute(
      ['--json', '--admin-base-url', baseUrl, '--token', 'admin-token', 'tags', 'list'],
      {},
    )

    assert.equal(result.exitCode, 1)
    assert.equal(result.payload.ok, false)
    assert.equal(result.payload.status_code, 403)
    assert.deepEqual(result.payload.error, { code: 'forbidden', message: '没有权限' })
    assert.equal(result.payload.meta.request.path, 'tags')
  })
})
