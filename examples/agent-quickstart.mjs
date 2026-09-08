#!/usr/bin/env node
/**
 * 拾光轴 · Timeline Board —— 第三方 agent 接入参考实现（change-set 协议，v19）
 *
 * 零依赖、Node ≥ 22 直跑。演示两个典型 Use Case（协议细节见 docs/agent-api.md）：
 *
 *   Use Case A（默认）：策划方案 → 生成卡片（人工确认后写入）
 *     node examples/agent-quickstart.mjs --board <board_id> --password <密码>
 *       → auth → GET version → 创建 pending change-set（create op，带 source/actor）→ 打印待 review 信息
 *     node examples/agent-quickstart.mjs --board <board_id> --password <密码> --commit
 *       → 同上，随后带 Idempotency-Key 提交，打印 client_ref → 服务端 id 映射
 *
 *   Use Case B（--metrics）：已发布卡片 → 数据回填（可直接提交）
 *     node examples/agent-quickstart.mjs --board <board_id> --password <密码> --metrics
 *       → GET items?status=已发布 → 每张卡构造 patch op（status 已发布 + 指标 + comment 同帧，
 *         避免指标 gate 清空）→ change-set → commit → GET /audit 打印溯源条目
 *
 * 参数（CLI 优先，环境变量兜底）：--api / API（缺省 http://localhost:8787）、
 *   --board / BOARD、--password / PASSWORD。
 *
 * 注意：这是参考实现而非生产代码——真实 agent 应把「采集数据」换成真实抓取，
 * 并在 commit 失败时先 GET change-set 状态再决定重试（不要盲重试）。
 */

// ---------------------------------------------------------------------------
// 参数与环境
// ---------------------------------------------------------------------------
const args = process.argv.slice(2)
const flag = (name) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}
const has = (name) => args.includes(name)

const API = (flag('--api') ?? process.env.API ?? 'http://localhost:8787').replace(/\/+$/, '')
const BOARD = flag('--board') ?? process.env.BOARD
const PASSWORD = flag('--password') ?? process.env.PASSWORD
const WITH_COMMIT = has('--commit') // Use Case A：创建后紧接提交
const METRICS_MODE = has('--metrics') // Use Case B：数据回填

function die(msg) {
  console.error(`✗ ${msg}`)
  process.exit(1)
}
if (!BOARD) die('缺少看板 id：--board <board_id> 或环境变量 BOARD')
if (!PASSWORD) die('缺少看板密码：--password <密码> 或环境变量 PASSWORD')

// ---------------------------------------------------------------------------
// HTTP 辅助：统一中文报错；429 按 retry_after 退避一次
// ---------------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function api(method, p, { token, body, headers } = {}) {
  for (let attempt = 0; ; attempt++) {
    let res
    try {
      res = await fetch(`${API}/api${p}`, {
        method,
        headers: {
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
    } catch (e) {
      die(`无法连接 ${API}（${e.cause?.code ?? e.message}）——请确认 server 已启动、--api 地址正确`)
    }
    const json = await res.json().catch(() => null)
    if (res.status === 429 && attempt === 0) {
      const wait = Number(json?.retry_after ?? 1)
      console.error(`  … 限速 429，按 retry_after 等待 ${wait} 秒后重试`)
      await sleep(wait * 1000)
      continue
    }
    return { status: res.status, body: json }
  }
}

/** 密码换 token（鉴权与人同一套，无独立 agent key） */
async function auth() {
  const r = await api('POST', `/boards/${BOARD}/auth`, { body: { password: PASSWORD } })
  if (r.status === 404) die(`看板不存在: ${BOARD}`)
  if (r.status === 403) die('密码错误（403）')
  if (r.status !== 200) die(`鉴权失败（HTTP ${r.status}）: ${r.body?.error ?? ''}`)
  console.log(`✓ 鉴权成功（token 有效期至 ${r.body.expires_at}）`)
  return r.body.token
}

/** 整板 GET：取当前 version（作 change-set 的 base_version） */
async function getVersion(token) {
  const r = await api('GET', `/boards/${BOARD}`, { token })
  if (r.status === 401) die('token 缺失或已过期（401）')
  if (r.status !== 200) die(`读取看板失败（HTTP ${r.status}）`)
  return r.body.version
}

/**
 * 创建 change-set 并（可选）提交。
 * commit 带 Idempotency-Key：同 change_set_id + 同键重试返回首次结果（不重复写入）；
 * 409 VERSION_CONFLICT 时重新取 version 重建 change-set 重试一次（仍冲突则报错退出）。
 */
async function createAndCommit(token, { operations, runId, idemKey, commit }) {
  let baseVersion = await getVersion(token)
  for (let attempt = 0; ; attempt++) {
    const cs = await api('POST', `/boards/${BOARD}/change-sets`, {
      token,
      body: {
        base_version: baseVersion,
        source: { type: 'agent', external_run_id: runId }, // 自报来源，服务端透传进审计
        actor: { type: 'agent', id: 'agent-quickstart' }, // 自报执行者
        operations,
      },
    })
    if (cs.status === 400) die(`change-set 预校验失败: ${cs.body?.error}`)
    if (cs.status !== 201) die(`创建 change-set 失败（HTTP ${cs.status}）: ${cs.body?.error ?? ''}`)
    const csid = cs.body.change_set_id
    console.log(`✓ change-set 已创建: ${csid}（status: pending，base_version: ${baseVersion}，expires_at: ${cs.body.expires_at}）`)

    if (!commit) return { csid, baseVersion }

    const cr = await api('POST', `/boards/${BOARD}/change-sets/${csid}/commit`, {
      token,
      body: {},
      headers: { 'idempotency-key': idemKey },
    })
    if (cr.status === 200) {
      console.log(`✓ 已提交: committed，看板 version ${baseVersion} → ${cr.body.version}`)
      return { csid, baseVersion, result: cr.body }
    }
    if (cr.status === 409 && cr.body?.error === 'VERSION_CONFLICT' && attempt === 0) {
      console.error(`  … version 冲突（当前 ${cr.body.current_version}）：他端有写入，重新取 version 重建 change-set 重试一次`)
      baseVersion = await getVersion(token)
      continue
    }
    if (cr.status === 400) {
      console.error(`✗ commit 被 core 校验拒绝（change-set 已置 rejected，看板零变化）:`)
      for (const e of cr.body?.errors ?? [cr.body?.error]) console.error(`  ✗ ${e}`)
      process.exit(1)
    }
    die(`commit 失败（HTTP ${cr.status}）: ${cr.body?.error ?? ''}`)
  }
}

// ---------------------------------------------------------------------------
// Use Case A：策划方案 → 生成卡片（人工确认后写入）
// ---------------------------------------------------------------------------
async function useCaseA(token) {
  const runId = `quickstart-A-${new Date().toISOString()}`
  const day = new Date(Date.now() + 86400000).toISOString().slice(0, 10) // 明天
  // 真实场景中 operations 来自策划方案的逐行拆解；client_ref 是方案行号等客户端追踪柄
  const operations = [
    {
      op: 'create',
      client_ref: 'plan-row-001',
      item: { title: '发布会切片（quickstart 示例）', type: '视频', publish_at: `${day}T10:00`, status: '待执行' },
    },
  ]
  const { csid, result } = await createAndCommit(token, {
    operations,
    runId,
    idemKey: `quickstart-A-${BOARD}-${runId}`,
    commit: WITH_COMMIT,
  })
  if (!WITH_COMMIT) {
    console.log('\n下一步：团队 GET 该 change-set 做人工 review，确认后提交：')
    console.log(`  查询: curl -s -H "authorization: Bearer <token>" ${API}/api/boards/${BOARD}/change-sets/${csid}`)
    console.log(`  提交: curl -X POST -H "authorization: Bearer <token>" -H "Idempotency-Key: <键>" ${API}/api/boards/${BOARD}/change-sets/${csid}/commit`)
    console.log('（或重跑本脚本加 --commit 直接创建并提交）')
    return
  }
  console.log('client_ref → 服务端分配 id:')
  for (const m of result.items) console.log(`  ${m.client_ref} → ${m.id}`)
}

// ---------------------------------------------------------------------------
// Use Case B：已发布卡片 → 数据回填（可直接提交）
// ---------------------------------------------------------------------------
async function useCaseB(token) {
  const list = await api('GET', `/boards/${BOARD}/items?status=${encodeURIComponent('已发布')}`, { token })
  if (list.status !== 200) die(`查询已发布卡片失败（HTTP ${list.status}）`)
  const published = list.body.items
  if (published.length === 0) {
    console.log('没有已发布卡片，无事可做（先用 Use Case A 或页面创建并发布卡片）')
    return
  }
  console.log(`✓ 已发布卡片 ${published.length} 张，开始回填（示例用模拟数据；真实场景在此访问 links[rel=publish].url 采集）`)

  const stamp = new Date().toISOString().slice(0, 10)
  const operations = published.map((it, i) => ({
    op: 'patch',
    item_id: it.id,
    changes: {
      // 指标必须与 status:"已发布" 同帧，否则被指标 gate 清空
      status: '已发布',
      propagation_4h: 1000 * (i + 1),
      engagement_4h: 100 * (i + 1),
      comment: `${stamp} 自动采集（quickstart 示例数据）：曝光 ${1000 * (i + 1)} / 互动 ${100 * (i + 1)}`,
    },
  }))
  const runId = `quickstart-B-${new Date().toISOString()}`
  await createAndCommit(token, {
    operations,
    runId,
    idemKey: `quickstart-B-${BOARD}-${runId}`,
    commit: true,
  })

  // 事后溯源：审计条目含 actor / source / change_set_id / request_id（逐字段一条）
  const audit = await api('GET', `/boards/${BOARD}/audit?limit=${Math.min(operations.length * 4, 200)}`, { token })
  console.log('\n审计溯源（逐字段，倒序）:')
  for (const e of audit.body.entries) {
    const actor = e.actor ? JSON.parse(e.actor).id : '(直接 PATCH)'
    console.log(`  [${e.change_set_id ?? '-'}] ${e.item_id} ${e.field}: ${e.old_value} → ${e.new_value}  by ${actor} @ ${e.ts}`)
  }
}

// ---------------------------------------------------------------------------
const token = await auth()
if (METRICS_MODE) await useCaseB(token)
else await useCaseA(token)
