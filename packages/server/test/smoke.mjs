#!/usr/bin/env node
/**
 * @timeline/server 冒烟（node 脚本，无浏览器）：起子进程 server（端口 5197 +
 * 临时 sqlite 自建自删），跑通 Agent API 主链路：
 * 建板 → 密码换 token → items 过滤 → 单卡 → PATCH（校验/指标联动/负责人登记/
 * orders 联动 / If-Match）→ audit → 无变化幂等 →
 * v19 change-set 全流程（创建/预校验 400/GET/commit/审计五字段/幂等重试/键复用 409/
 * 版本冲突 conflicted/校验失败 rejected/cancel/惰性 expired/2000 上限全批拒绝）→
 * PUT If-Match → 删板。随后换 BOARD_AGENT_RPM=3 低上限实例补测限速 429。
 * 跑完杀进程组、删临时库。
 *
 * 端口纪律：仅用 5197；不碰 5198/5199（e2e）与 7100/7101/7102/8787。
 */
import { spawn } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PORT = 5197
const API = `http://localhost:${PORT}/api`
const DB = path.join(os.tmpdir(), `timeline-server-smoke-${process.pid}.sqlite`)
const SERVER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'index.mjs')

let passed = 0
let failed = 0
const ok = (cond, name, detail = '') => {
  if (cond) {
    passed++
    console.log(`  ✓ ${name}`)
  } else {
    failed++
    console.error(`  ✗ ${name} ${detail}`)
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function api(method, p, body, token, headers = {}) {
  const res = await fetch(`${API}${p}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  let json = null
  try {
    json = await res.json()
  } catch {
    // 204
  }
  return { status: res.status, body: json, headers: res.headers }
}

let proc = null
try {
  for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) rmSync(f, { force: true })
  proc = spawn(process.execPath, [SERVER], {
    detached: true,
    env: {
      ...process.env,
      API_PORT: String(PORT),
      BOARD_DB: DB,
      BOARD_SECRET: 'smoke-secret',
      BOARD_AGENT_RPM: '1000', // 主链路不限速；429 单独用低上限实例测
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(`${API}/health`, { signal: AbortSignal.timeout(500) })
      if (r.ok) break
    } catch {}
    if (i > 40) throw new Error('server 启动超时')
    await sleep(250)
  }

  // 建板（3 卡：昨天已发布带指标 / 今天待发布 / 明天待执行）
  const pad = (n) => String(n).padStart(2, '0')
  const fmt = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  const day = (n) => fmt(new Date(Date.now() + n * 86400000))
  const doc = {
    items: [
      { id: 's-01', title: '昨日卡', type: '图文', publish_at: `${day(-1)}T09:00`, roi: 2.5, comment: '', product_id: 'P-1000', status: '已发布', content_owner_id: '', delivery_owner_id: '', propagation_4h: 12000, engagement_4h: 800 },
      { id: 's-02', title: '今日卡', type: '视频', publish_at: `${day(0)}T10:00`, roi: null, comment: '', product_id: 'P-1000', status: '待发布', content_owner_id: 'M-1001', delivery_owner_id: '', propagation_4h: null, engagement_4h: null },
      { id: 's-03', title: '明日卡', type: '数据', publish_at: `${day(1)}T11:00`, roi: null, comment: '', product_id: '', status: '待执行', content_owner_id: '', delivery_owner_id: '', propagation_4h: null, engagement_4h: null },
    ],
    orders: { 's-01': 0, 's-02': 0, 's-03': 0 },
    products: [{ id: 'P-1000', name: '光轴' }],
    members: [{ id: 'M-1001', name: '林晓' }],
    meta: { name: 'smoke', created_at: new Date().toISOString() },
  }
  const mk = await api('POST', '/boards', { name: 'smoke 板', password: 'pw', doc })
  ok(mk.status === 201, '建板 201')
  const bid = mk.body.board_id

  const noTok = await api('GET', `/boards/${bid}/items`)
  ok(noTok.status === 401, '无 token 401')
  const auth = await api('POST', `/boards/${bid}/auth`, { password: 'pw' })
  ok(auth.status === 200 && auth.body.token, '密码换 token')
  const tk = auth.body.token

  const list = await api('GET', `/boards/${bid}/items`, undefined, tk)
  ok(list.status === 200 && list.body.items.length === 3, 'items 列表 3 张')
  const filt = await api('GET', `/boards/${bid}/items?date=${day(0)}&status=${encodeURIComponent('待发布')}`, undefined, tk)
  ok(filt.body.items.length === 1 && filt.body.items[0].id === 's-02', 'date+status 叠加过滤')
  const byMember = await api('GET', `/boards/${bid}/items?member=${encodeURIComponent('林晓')}`, undefined, tk)
  ok(byMember.body.items.length === 1 && byMember.body.items[0].id === 's-02', 'member=姓名过滤')
  const byQ = await api('GET', `/boards/${bid}/items?q=${encodeURIComponent('明日')}`, undefined, tk)
  ok(byQ.body.items.length === 1 && byQ.body.items[0].id === 's-03', 'q 关键词过滤')
  const sorted = list.body.items.every((it, i, a) => i === 0 || a[i - 1].publish_at <= it.publish_at)
  ok(sorted, '按 publish_at 升序')

  const one = await api('GET', `/boards/${bid}/items/s-02`, undefined, tk)
  ok(one.status === 200 && one.body.item.title === '今日卡', '单卡 GET')
  const miss = await api('GET', `/boards/${bid}/items/nope`, undefined, tk)
  ok(miss.status === 404, '单卡 404')

  // PATCH：标题 + 指标联动（待发布写 roi 强制 null；置已发布后指标可写）
  const p1 = await api('PATCH', `/boards/${bid}/items/s-02`, { title: '今日卡·改', roi: 9.9 }, tk)
  ok(p1.body.changed === true && p1.body.item.title === '今日卡·改' && p1.body.item.roi === null, 'PATCH 改标题；待发布 roi 强制 null')
  const p2 = await api('PATCH', `/boards/${bid}/items/s-02`, { status: '已发布', roi: 3.3 }, tk)
  ok(p2.body.item.status === '已发布' && p2.body.item.roi === 3.3, '已发布可写指标')
  const pBad = await api('PATCH', `/boards/${bid}/items/s-02`, { id: 'x' }, tk)
  ok(pBad.status === 400 && /不支持修改的字段: id/.test(pBad.body.error), '白名单外字段 400')
  const pEnum = await api('PATCH', `/boards/${bid}/items/s-02`, { status: '进行中' }, tk)
  ok(pEnum.status === 400 && /status 非法/.test(pEnum.body.error), '非法枚举 400')
  const pOwner = await api('PATCH', `/boards/${bid}/items/s-02`, { content_owner_id: '赵六' }, tk)
  ok(pOwner.body.item.content_owner_id === 'M-1002', '未知负责人姓名自动登记 M-1002')
  const mems = await api('GET', `/boards/${bid}/members`, undefined, tk)
  ok(mems.body.members.some((m) => m.name === '赵六'), 'members 端点可见新成员')
  const prods = await api('GET', `/boards/${bid}/products`, undefined, tk)
  ok(prods.body.products.length === 1 && prods.body.products[0].id === 'P-1000', 'products 端点')

  // orders 联动（v2-M2 统一分组模型：无分组的板只有虚拟「未分组」一列，改期不跨列 → 不动 orders；
  // 跨列重取 order 的断言见下方 M2 分组段的 PATCH 改期）
  const pDate = await api('PATCH', `/boards/${bid}/items/s-03`, { publish_at: `${day(-1)} 12:00` }, tk)
  ok(pDate.body.item.publish_at === `${day(-1)}T12:00`, 'publish_at 归一化')
  const full = await api('GET', `/boards/${bid}`, undefined, tk)
  ok(full.body.doc.orders['s-03'] === 0 && full.body.doc.orders['s-01'] === 0, '无分组板改期不动 orders（同属未分组列）')

  // 审计：逐字段旧→新（倒序，最新是 publish_at）
  const audit = await api('GET', `/boards/${bid}/audit?limit=50`, undefined, tk)
  const f = audit.body.entries
  ok(f.length >= 5 && f[0].field === 'publish_at' && f[0].item_id === 's-03', 'audit 逐字段倒序', JSON.stringify(f?.[0]))
  ok(f.some((e) => e.field === 'roi' && e.old_value === 'null' && e.new_value === '3.3'), 'audit 指标旧→新（JSON 序列化）')

  // 无变化 PATCH：200 但不写审计、version 不增
  const v1 = full.body.version
  const a1 = audit.body.entries[0].id
  const pSame = await api('PATCH', `/boards/${bid}/items/s-02`, { title: '今日卡·改', roi: 3.3 }, tk)
  const full2 = await api('GET', `/boards/${bid}`, undefined, tk)
  const audit2 = await api('GET', `/boards/${bid}/audit?limit=1`, undefined, tk)
  ok(pSame.body.changed === false && full2.body.version === v1 && audit2.body.entries[0].id === a1, '无变化 PATCH 幂等（不写审计不增 version）')

  // ------------------------------------------------------------------
  // v19 change-set 全流程（协议 §5.4–5.7）
  // ------------------------------------------------------------------
  const ver0 = full2.body.version

  // 预校验失败：空 operations → 400，不产生记录
  const csBad = await api('POST', `/boards/${bid}/change-sets`, { base_version: ver0, operations: [] }, tk)
  ok(csBad.status === 400 && /非空数组/.test(csBad.body.error), 'change-set 空 operations 预校验 400')

  // 创建提案：2 create（含 links）+ 1 patch（未知负责人姓名登记）
  const csCreate = await api(
    'POST',
    `/boards/${bid}/change-sets`,
    {
      base_version: ver0,
      source: { type: 'agent', external_run_id: 'run-smoke-001' },
      actor: { type: 'agent', id: 'agent-smoke' },
      operations: [
        { op: 'create', client_ref: 'row-1', item: { title: 'CS新卡A', publish_at: `${day(0)}T20:00` } },
        {
          op: 'create',
          client_ref: 'row-2',
          item: {
            title: 'CS新卡B',
            publish_at: `${day(0)}T21:00`,
            links: [{ id: 'l1', rel: 'publish', url: 'https://x.com/p/1', platform: 'xiaohongshu' }],
          },
        },
        { op: 'patch', item_id: 's-03', changes: { comment: 'Agent 回填完成', delivery_owner_id: '钱七' } },
      ],
    },
    tk,
  )
  ok(
    csCreate.status === 201 && csCreate.body.status === 'pending' && /^cs-[0-9a-f]{16}$/.test(csCreate.body.change_set_id),
    'change-set 创建 201 pending',
    JSON.stringify(csCreate.body),
  )
  ok(csCreate.body.expires_at > csCreate.body.created_at && csCreate.body.result === null, 'expires_at 写入，result 初始 null')
  const csid = csCreate.body.change_set_id

  // GET review + 404
  const csGet = await api('GET', `/boards/${bid}/change-sets/${csid}`, undefined, tk)
  ok(csGet.status === 200 && csGet.body.operations.length === 3 && csGet.body.actor.id === 'agent-smoke', 'change-set GET review')
  const cs404 = await api('GET', `/boards/${bid}/change-sets/cs-0000000000000000`, undefined, tk)
  ok(cs404.status === 404, 'change-set 404')

  // commit（带幂等键）→ committed：version+1、items 映射、卡片可见、orders 列尾、成员登记
  const commit = await api('POST', `/boards/${bid}/change-sets/${csid}/commit`, {}, tk, { 'idempotency-key': 'commit-smoke-1' })
  ok(commit.status === 200 && commit.body.status === 'committed' && commit.body.version === ver0 + 1, 'commit → committed version+1', JSON.stringify(commit.body))
  ok(
    commit.body.items.length === 2 && commit.body.items[0].client_ref === 'row-1' && commit.body.items[1].client_ref === 'row-2',
    'client_ref → id 映射',
  )
  const board1 = await api('GET', `/boards/${bid}`, undefined, tk)
  const doc1 = board1.body.doc
  ok(board1.body.version === ver0 + 1 && doc1.items.length === 5, '提交后卡片可见（3+2=5）')
  const [idA, idB] = commit.body.items.map((x) => x.id)
  ok(doc1.orders[idA] === 1 && doc1.orders[idB] === 2 && doc1.orders['s-02'] === 0, '新卡按 ops 顺序排当日列尾，已有顺序不动')
  ok(doc1.items.find((it) => it.id === idB).links?.[0]?.url === 'https://x.com/p/1', 'links 随 create 写入')
  ok(doc1.members.some((m) => m.name === '钱七'), '未知负责人姓名经 change-set 登记')
  ok(doc1.items.find((it) => it.id === 's-03').comment === 'Agent 回填完成', 'patch op 生效')

  // 审计五字段：actor / source / change_set_id / request_id（逐条复制）
  const auditCs = await api('GET', `/boards/${bid}/audit?limit=50`, undefined, tk)
  const csEntries = auditCs.body.entries.filter((e) => e.change_set_id === csid)
  const e0 = csEntries[0] ?? {}
  ok(
    csEntries.length > 0 &&
      csEntries.every((e) => e.request_id && e.request_id === e0.request_id) &&
      JSON.parse(e0.actor ?? 'null')?.id === 'agent-smoke' &&
      JSON.parse(e0.source ?? 'null')?.external_run_id === 'run-smoke-001',
    '审计含 actor/source/change_set_id/request_id（同 ts 同 request_id）',
    JSON.stringify(e0),
  )
  ok(auditCs.body.entries.some((e) => e.change_set_id === null), '直接 PATCH 审计 change_set_id=null')

  // 幂等：同键同内容重试 → 相同结果，version 不再增
  const retry = await api('POST', `/boards/${bid}/change-sets/${csid}/commit`, {}, tk, { 'idempotency-key': 'commit-smoke-1' })
  const boardAfterRetry = await api('GET', `/boards/${bid}`, undefined, tk)
  ok(
    retry.status === 200 && retry.body.version === commit.body.version && boardAfterRetry.body.version === ver0 + 1,
    '同 Idempotency-Key 重试返回首次结果（version 不增）',
  )
  // 同键不同内容 → 409 IDEMPOTENCY_KEY_REUSE
  const reuse = await api('POST', `/boards/${bid}/change-sets/${csid}/commit`, { note: 'changed' }, tk, { 'idempotency-key': 'commit-smoke-1' })
  ok(reuse.status === 409 && reuse.body.error === 'IDEMPOTENCY_KEY_REUSE', '同键不同内容 409 IDEMPOTENCY_KEY_REUSE')
  // 无键重复 commit → 409 已终态
  const recommit = await api('POST', `/boards/${bid}/change-sets/${csid}/commit`, {}, tk)
  ok(recommit.status === 409 && recommit.body.status === 'committed', '无键重复 commit → 409 已终态')

  // 版本冲突：base_version 过期 → 409 + conflicted + 看板零变化
  const csStale = await api('POST', `/boards/${bid}/change-sets`, {
    base_version: ver0, // 已过期（当前 ver0+1）
    operations: [{ op: 'create', item: { title: '幽灵卡', publish_at: `${day(0)}T22:00` } }],
  }, tk)
  const commitStale = await api('POST', `/boards/${bid}/change-sets/${csStale.body.change_set_id}/commit`, {}, tk)
  ok(commitStale.status === 409 && commitStale.body.error === 'VERSION_CONFLICT' && commitStale.body.current_version === ver0 + 1, 'base_version 过期 → 409 VERSION_CONFLICT')
  const csStaleGet = await api('GET', `/boards/${bid}/change-sets/${csStale.body.change_set_id}`, undefined, tk)
  const boardStale = await api('GET', `/boards/${bid}`, undefined, tk)
  ok(csStaleGet.body.status === 'conflicted' && boardStale.body.doc.items.length === 5, 'conflicted 落库且看板零变化')

  // 校验失败：commit 时 core 全量校验报错 → 400 + rejected + 看板零变化
  const csInvalid = await api('POST', `/boards/${bid}/change-sets`, {
    base_version: ver0 + 1,
    operations: [{ op: 'patch', item_id: 'ghost-card', changes: { title: 'x' } }],
  }, tk)
  ok(csInvalid.status === 201, 'patch 不存在卡片可过预校验（存在性检查在 commit）')
  const commitInvalid = await api('POST', `/boards/${bid}/change-sets/${csInvalid.body.change_set_id}/commit`, {}, tk)
  ok(commitInvalid.status === 400 && /卡片不存在/.test(commitInvalid.body.error), 'commit 校验失败 400（中文文案透传）')
  const csInvalidGet = await api('GET', `/boards/${bid}/change-sets/${csInvalid.body.change_set_id}`, undefined, tk)
  const boardInvalid = await api('GET', `/boards/${bid}`, undefined, tk)
  ok(
    csInvalidGet.body.status === 'rejected' && Array.isArray(csInvalidGet.body.result?.errors) && boardInvalid.body.version === ver0 + 1,
    'rejected 落库（result 含 errors），看板零变化',
  )

  // cancel：pending → rejected；重复 cancel / 终态 commit → 409
  const csCancel = await api('POST', `/boards/${bid}/change-sets`, {
    base_version: ver0 + 1,
    operations: [{ op: 'create', item: { title: '待取消', publish_at: `${day(0)}T23:00` } }],
  }, tk)
  const cancel1 = await api('POST', `/boards/${bid}/change-sets/${csCancel.body.change_set_id}/cancel`, {}, tk)
  ok(cancel1.status === 200 && cancel1.body.status === 'rejected', 'cancel → rejected')
  const cancel2 = await api('POST', `/boards/${bid}/change-sets/${csCancel.body.change_set_id}/cancel`, {}, tk)
  ok(cancel2.status === 409, '重复 cancel → 409')
  const commitCancelled = await api('POST', `/boards/${bid}/change-sets/${csCancel.body.change_set_id}/commit`, {}, tk)
  ok(commitCancelled.status === 409, '已取消 commit → 409')

  // 惰性过期：直接改库 expires_at 到过去 → GET 触发 expired 并落库；commit 409
  const csExp = await api('POST', `/boards/${bid}/change-sets`, {
    base_version: ver0 + 1,
    operations: [{ op: 'create', item: { title: '过期卡', publish_at: `${day(0)}T23:30` } }],
  }, tk)
  {
    const tdb = new DatabaseSync(DB)
    tdb.prepare('UPDATE change_sets SET expires_at = ? WHERE change_set_id = ?').run(new Date(Date.now() - 1000).toISOString(), csExp.body.change_set_id)
    tdb.close()
  }
  const csExpGet = await api('GET', `/boards/${bid}/change-sets/${csExp.body.change_set_id}`, undefined, tk)
  ok(csExpGet.body.status === 'expired', '惰性过期：GET 判定 expired')
  const csExpGet2 = await api('GET', `/boards/${bid}/change-sets/${csExp.body.change_set_id}`, undefined, tk)
  ok(csExpGet2.body.status === 'expired', 'expired 已落库（非每次重算）')
  const commitExp = await api('POST', `/boards/${bid}/change-sets/${csExp.body.change_set_id}/commit`, {}, tk)
  ok(commitExp.status === 409 && commitExp.body.status === 'expired', '过期 commit → 409')

  // ------------------------------------------------------------------
  // v2-M2 F3 统一分组模型（3 个 doc 级 op + group_id 写入严格 + 写入时归属解析 + 61 上限）
  // ------------------------------------------------------------------
  // 单卡 PATCH group_id：板上无分组 → 悬空拒绝（写入严格）
  const pGidGhost = await api('PATCH', `/boards/${bid}/items/s-02`, { group_id: 'grp-ghost' }, tk)
  ok(pGidGhost.status === 400 && /group_id 不存在/.test(pGidGhost.body.error), 'PATCH 悬空 group_id 400（写入严格）')

  // change-set：建三组（含一个同名日期组）+ 新卡引用 client_ref + 写入时归属解析 + 显式 null → 一次事务提交
  const verG = (await api('GET', `/boards/${bid}`, undefined, tk)).body.version
  const csGroup = await api('POST', `/boards/${bid}/change-sets`, {
    base_version: verG,
    operations: [
      { op: 'group_create', client_ref: 'g-test', group: { name: '测试阶段' } },
      { op: 'group_create', client_ref: 'g-release', group: { name: '发布阶段' } },
      { op: 'group_create', client_ref: 'g-date', group: { name: day(2) } },
      { op: 'create', client_ref: 'row-g', item: { title: '分组新卡', publish_at: `${day(0)}T15:00`, group_id: 'g-test' } },
      { op: 'create', client_ref: 'row-auto', item: { title: '归属解析卡', publish_at: `${day(2)}T10:00` } },
      { op: 'create', client_ref: 'row-null', item: { title: '显式未分组卡', publish_at: `${day(2)}T11:00`, group_id: null } },
      { op: 'patch', item_id: 's-02', changes: { group_id: 'g-release' } },
    ],
  }, tk)
  ok(csGroup.status === 201, 'change-set 含 group op 创建 201', JSON.stringify(csGroup.body))
  const commitG = await api('POST', `/boards/${bid}/change-sets/${csGroup.body.change_set_id}/commit`, {}, tk)
  ok(commitG.status === 200 && commitG.body.status === 'committed', 'group op change-set commit 成功', JSON.stringify(commitG.body))
  ok(commitG.body.groups?.length === 3 && commitG.body.groups[0].client_ref === 'g-test', 'commit 结果含 client_ref → 分组 id 映射')
  const gidTest = commitG.body.groups[0].id
  const gidRelease = commitG.body.groups[1].id
  const gidDate = commitG.body.groups[2].id
  const docG = (await api('GET', `/boards/${bid}`, undefined, tk)).body.doc
  ok(docG.groups?.length === 3 && docG.groups[0].name === '测试阶段' && docG.groups[2].name === day(2), '分组落盘（数组序 = 列顺序）')
  const createdCards = Object.fromEntries(commitG.body.items.map((x) => [x.client_ref, x.id]))
  ok(docG.items.find((it) => it.id === createdCards['row-g']).group_id === gidTest, 'set 内先建后引用：新卡 group_id = 新分组 id')
  ok(docG.items.find((it) => it.id === createdCards['row-auto']).group_id === gidDate, '写入时归属解析：同名日期组自动挂入')
  ok(!('group_id' in docG.items.find((it) => it.id === createdCards['row-null'])), '显式 group_id null = 归未分组（不解析）')
  ok(docG.items.find((it) => it.id === 's-02').group_id === gidRelease, 'patch 引用 client_ref 落组')

  // 单卡 PATCH 改期：有同名日期组 → 自动挂入；无同名日期组 → 归未分组
  const pDateHit = await api('PATCH', `/boards/${bid}/items/s-01`, { publish_at: `${day(2)}T08:00` }, tk)
  ok(pDateHit.status === 200 && pDateHit.body.item.group_id === gidDate, 'PATCH 改期 → 同名日期组自动挂入')
  const docHit = (await api('GET', `/boards/${bid}`, undefined, tk)).body.doc
  ok(docHit.orders['s-01'] === 1, '改期跨列重取目标列尾 order（组内仅 row-auto 占 0 → 1）')
  const pDateMiss = await api('PATCH', `/boards/${bid}/items/s-01`, { publish_at: `${day(5)}T08:00` }, tk)
  ok(pDateMiss.status === 200 && !('group_id' in pDateMiss.body.item), 'PATCH 改期无同名日期组 → 归未分组（不自动建组）')
  const docAfterDate = (await api('GET', `/boards/${bid}`, undefined, tk)).body.doc
  ok(docAfterDate.groups.length === 3, '归属解析不自动建组（groups 数不变）')

  // 删组 move_to 可缺省 = 归未分组；显式 move_to = 迁移；重命名 + 调列序
  const csDel = await api('POST', `/boards/${bid}/change-sets`, {
    base_version: commitG.body.version + 2,
    operations: [
      { op: 'group_patch', group_id: gidRelease, changes: { name: '发布阶段·改', before_group_id: gidTest } },
      { op: 'group_delete', group_id: gidTest },
    ],
  }, tk)
  const commitDel = await api('POST', `/boards/${bid}/change-sets/${csDel.body.change_set_id}/commit`, {}, tk)
  ok(commitDel.status === 200, '重命名+调序+删组（move_to 缺省）一次提交', JSON.stringify(commitDel.body))
  const docG2 = (await api('GET', `/boards/${bid}`, undefined, tk)).body.doc
  ok(
    docG2.groups.length === 2 && docG2.groups[0].name === '发布阶段·改' &&
      !('group_id' in docG2.items.find((it) => it.id === createdCards['row-g'])),
    '删组缺省 move_to：组内卡片归未分组（group_id 移除）',
  )
  const csDel2 = await api('POST', `/boards/${bid}/change-sets`, {
    base_version: commitDel.body.version,
    operations: [{ op: 'group_delete', group_id: gidDate, move_to: gidRelease }],
  }, tk)
  const commitDel2 = await api('POST', `/boards/${bid}/change-sets/${csDel2.body.change_set_id}/commit`, {}, tk)
  const docG3 = (await api('GET', `/boards/${bid}`, undefined, tk)).body.doc
  ok(
    commitDel2.status === 200 && docG3.groups.length === 1 &&
      docG3.items.find((it) => it.id === createdCards['row-auto']).group_id === gidRelease,
    '删组显式 move_to：组内卡片迁入目标分组',
    JSON.stringify(commitDel2.body),
  )

  // 61 上限：补满到 61 个 → 第 62 个 group_create 400
  const curGroups = docG3.groups.length
  const csFill = await api('POST', `/boards/${bid}/change-sets`, {
    base_version: commitDel2.body.version,
    operations: Array.from({ length: 61 - curGroups }, (_, i) => ({
      op: 'group_create',
      group: { name: `填充组 ${i + 1}` },
    })),
  }, tk)
  const commitFill = await api('POST', `/boards/${bid}/change-sets/${csFill.body.change_set_id}/commit`, {}, tk)
  ok(commitFill.status === 200, `补满分组到 61（现有 ${curGroups}）`, JSON.stringify(commitFill.body))
  const csOver = await api('POST', `/boards/${bid}/change-sets`, {
    base_version: commitFill.body.version,
    operations: [{ op: 'group_create', group: { name: '第 62 组' } }],
  }, tk)
  const commitOver = await api('POST', `/boards/${bid}/change-sets/${csOver.body.change_set_id}/commit`, {}, tk)
  ok(commitOver.status === 400 && /分组已达上限 61 个/.test(commitOver.body.error), '第 62 个分组 → 400（61 上限）', JSON.stringify(commitOver.body))

  // PATCH If-Match：符合 → 正常；不符 → 409；不带 → 旧行为
  const curV = (await api('GET', `/boards/${bid}`, undefined, tk)).body.version
  const pMatch = await api('PATCH', `/boards/${bid}/items/s-02`, { comment: 'if-match ok' }, tk, { 'if-match': String(curV) })
  ok(pMatch.status === 200 && pMatch.body.changed === true, 'PATCH If-Match 符合 → 正常')
  const pConflict = await api('PATCH', `/boards/${bid}/items/s-02`, { comment: 'x' }, tk, { 'if-match': String(curV) })
  ok(pConflict.status === 409 && pConflict.body.error === 'VERSION_CONFLICT' && pConflict.body.current_version === curV + 1, 'PATCH If-Match 不符 → 409 VERSION_CONFLICT')
  const pNoMatch = await api('PATCH', `/boards/${bid}/items/s-02`, { comment: 'if-match ok' }, tk)
  ok(pNoMatch.status === 200 && pNoMatch.body.changed === false, 'PATCH 不带 If-Match 维持旧行为')

  // 2000 张上限：change-set 批量 create 触发全批拒绝
  const many = Array.from({ length: 1999 }, (_, i) => ({
    id: `b-${i}`, title: `卡${i}`, type: '图文', publish_at: `${day(0)}T09:00`, roi: null, comment: '',
    product_id: '', status: '待执行', content_owner_id: '', delivery_owner_id: '', propagation_4h: null, engagement_4h: null,
  }))
  const bigDoc = {
    items: many,
    orders: Object.fromEntries(many.map((it, i) => [it.id, i])),
    products: [], members: [],
    meta: { name: 'big', created_at: new Date().toISOString() },
  }
  const mkBig = await api('POST', '/boards', { name: 'big', password: 'pw', doc: bigDoc })
  const bigBid = mkBig.body.board_id
  const tkBig = (await api('POST', `/boards/${bigBid}/auth`, { password: 'pw' })).body.token
  const csBig = await api('POST', `/boards/${bigBid}/change-sets`, {
    base_version: 1,
    operations: [
      { op: 'create', item: { title: '超限A', publish_at: `${day(1)}T09:00` } },
      { op: 'create', item: { title: '超限B', publish_at: `${day(1)}T10:00` } },
    ],
  }, tkBig)
  const commitBig = await api('POST', `/boards/${bigBid}/change-sets/${csBig.body.change_set_id}/commit`, {}, tkBig)
  ok(commitBig.status === 400 && /2000 张上限/.test(commitBig.body.error), '2000 张上限全批拒绝 400')
  const bigAfter = await api('GET', `/boards/${bigBid}`, undefined, tkBig)
  const csBigGet = await api('GET', `/boards/${bigBid}/change-sets/${csBig.body.change_set_id}`, undefined, tkBig)
  ok(bigAfter.body.doc.items.length === 1999 && csBigGet.body.status === 'rejected', '超限看板零变化 + rejected 落库')
  await api('DELETE', `/boards/${bigBid}`, { password: 'pw' })

  const del = await api('DELETE', `/boards/${bid}`, { password: 'pw' })
  ok(del.status === 204, '删板 204')

  // 既有整板路径回归：PUT version+1 / ?version=N changed:false
  const mk2 = await api('POST', '/boards', { name: '回归', password: 'pw' })
  const bid2 = mk2.body.board_id
  const tk2 = (await api('POST', `/boards/${bid2}/auth`, { password: 'pw' })).body.token
  const put = await api('PUT', `/boards/${bid2}`, { doc }, tk2)
  const same = await api('GET', `/boards/${bid2}?version=${put.body.version}`, undefined, tk2)
  ok(put.status === 200 && same.body.changed === false, 'PUT/version 轮询语义不变')
  ok(put.headers.get('deprecation') === 'true', 'PUT 无 If-Match → 兼容模式 + Deprecation 头')

  // PUT If-Match：符合 → 200；不符 → 409
  const putMatch = await api('PUT', `/boards/${bid2}`, { doc }, tk2, { 'if-match': String(put.body.version) })
  ok(putMatch.status === 200 && putMatch.headers.get('deprecation') === null, 'PUT If-Match 符合 → 200 且无 Deprecation 头')
  const putConflict = await api('PUT', `/boards/${bid2}`, { doc }, tk2, { 'if-match': String(put.body.version) })
  ok(putConflict.status === 409 && putConflict.body.error === 'VERSION_CONFLICT', 'PUT If-Match 不符 → 409 VERSION_CONFLICT')
  await api('DELETE', `/boards/${bid2}`, { password: 'pw' })
} catch (e) {
  failed++
  console.error('  ✗ 冒烟主流程异常：', e)
} finally {
  if (proc && !proc.killed) {
    try {
      process.kill(-proc.pid, 'SIGKILL')
    } catch {
      try { proc.kill('SIGKILL') } catch {}
    }
  }
  await sleep(200)
}

// ---------------------------------------------------------------------------
// 限速 429 用例：BOARD_AGENT_RPM=3 低上限实例（换独立临时库，同端口重启）
// ---------------------------------------------------------------------------
let proc2 = null
const DB2 = `${DB}-rl`
try {
  for (const f of [DB2, `${DB2}-wal`, `${DB2}-shm`]) rmSync(f, { force: true })
  proc2 = spawn(process.execPath, [SERVER], {
    detached: true,
    env: { ...process.env, API_PORT: String(PORT), BOARD_DB: DB2, BOARD_SECRET: 'smoke-secret', BOARD_AGENT_RPM: '3' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(`${API}/health`, { signal: AbortSignal.timeout(500) })
      if (r.ok) break
    } catch {}
    if (i > 40) throw new Error('限速实例启动超时')
    await sleep(250)
  }
  const mkRl = await api('POST', '/boards', { name: '限速', password: 'pw' })
  const rlBid = mkRl.body.board_id
  const rlTk = (await api('POST', `/boards/${rlBid}/auth`, { password: 'pw' })).body.token
  const rl1 = await api('GET', `/boards/${rlBid}/items`, undefined, rlTk)
  const rl2 = await api('GET', `/boards/${rlBid}/items`, undefined, rlTk)
  const rl3 = await api('GET', `/boards/${rlBid}/items`, undefined, rlTk)
  const rl4 = await api('GET', `/boards/${rlBid}/items`, undefined, rlTk)
  ok(rl1.status === 200 && rl2.status === 200 && rl3.status === 200, '限速窗口内前 3 次放行')
  ok(rl4.status === 429 && rl4.body.retry_after > 0, '第 4 次 429 + retry_after', JSON.stringify(rl4.body))
  // change-sets 计入同一限速桶
  const rl5 = await api('POST', `/boards/${rlBid}/change-sets`, { base_version: 1, operations: [{ op: 'create', item: { title: 'x', publish_at: '2026-09-10T09:00' } }] }, rlTk)
  ok(rl5.status === 429, 'change-sets 端点计入同一限速桶')
} catch (e) {
  failed++
  console.error('  ✗ 限速用例异常：', e)
} finally {
  if (proc2 && !proc2.killed) {
    try {
      process.kill(-proc2.pid, 'SIGKILL')
    } catch {
      try { proc2.kill('SIGKILL') } catch {}
    }
  }
  await sleep(200)
  for (const f of [DB, `${DB}-wal`, `${DB}-shm`, DB2, `${DB2}-wal`, `${DB2}-shm`]) rmSync(f, { force: true })
}

console.log(`\n[server-smoke] ${passed} PASS / ${failed} FAIL`)
process.exit(failed ? 1 : 0)
