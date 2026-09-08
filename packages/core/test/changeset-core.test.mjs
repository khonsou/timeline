/**
 * @timeline/core changeset-core 单测（node:test）：变更集纯函数验证（协议 §4.2 / §5.4–5.7 / §6）。
 * 覆盖：预校验（空 operations / op 类型 / 白名单 / links 形状）、create 按 ops 顺序排入当日列尾、
 * client_ref→id 映射与 id 确定性、跨日 patch 联动 orders、指标 gate 双向、负责人登记与 set 内去重、
 * 2000 张上限全批拒绝、重复 id 拒绝、幂等同值 patch 无变更记录、全批拒绝不产生部分结果、
 * import-core 归一化 links 原样往返。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  BOARD_ITEM_LIMIT,
  applyChangeSet,
  newChangeSetItemId,
  validateChangeSet,
} from '@timeline/core/changeset-core'
import { validateItems } from '@timeline/core/import-core'

const MEMBERS = [{ id: 'M-1001', name: '林晓' }]

/** 已发布带指标卡（over 可覆盖任意字段） */
const item = (over = {}) => ({
  id: 's-01',
  title: '示例卡',
  type: '图文',
  status: '已发布',
  publish_at: '2026-09-10T09:00',
  product_id: 'P-1000',
  content_owner_id: 'M-1001',
  delivery_owner_id: '',
  roi: 1.5,
  propagation_4h: 100,
  engagement_4h: 20,
  comment: '',
  ...over,
})

/** 看板快照：s-01 在 09-10（order 0）；s-02 / s-03 在 09-11（order 0/1） */
const doc = (over = {}) => ({
  items: [
    item(),
    item({ id: 's-02', publish_at: '2026-09-11T08:00' }),
    item({ id: 's-03', publish_at: '2026-09-11T10:00' }),
  ],
  orders: { 's-01': 0, 's-02': 0, 's-03': 1 },
  products: [{ id: 'P-1000', name: '光轴' }],
  members: MEMBERS.map((m) => ({ ...m })),
  meta: { name: '测试板', created_at: '2026-09-01T00:00:00.000Z' },
  ...over,
})

describe('validateChangeSet 预校验', () => {
  it('空 operations / 非数组 / 空数组被拒绝', () => {
    assert.deepEqual(validateChangeSet({}).errors, ['operations 须为非空数组'])
    assert.deepEqual(validateChangeSet({ operations: [] }).errors, ['operations 须为非空数组'])
    assert.deepEqual(validateChangeSet({ operations: 'x' }).errors, ['operations 须为非空数组'])
    assert.deepEqual(validateChangeSet(null).errors, ['请求体须为对象'])
  })
  it('op 仅允许 create / patch', () => {
    const r = validateChangeSet({ operations: [{ op: 'delete', item_id: 's-01' }] })
    assert.deepEqual(r.errors, ['operations[0].op 非法: "delete"，合法值: create / patch'])
  })
  it('patch 的 changes 走同一套白名单与文案；create 不允许指定 id', () => {
    const r = validateChangeSet({
      operations: [
        { op: 'patch', item_id: 's-01', changes: { id: 'x', orders: 1 } },
        { op: 'create', item: { id: 'c-1', title: 't', publish_at: '2026-09-10T09:00' } },
        { op: 'create', item: { title: 't', publish_at: '2026-09-10T09:00', foo: 1 } },
      ],
    })
    assert.deepEqual(r.errors, [
      'operations[0].changes 不支持修改的字段: id, orders',
      'operations[1].item 不允许指定 id（服务端分配）',
      'operations[2].item 不支持字段: foo',
    ])
  })
  it('create 缺 title / publish_at 必填报错；publish_at 归一化进 normalized', () => {
    const bad = validateChangeSet({ operations: [{ op: 'create', item: { title: '  ' } }] })
    assert.deepEqual(bad.errors, [
      'operations[0].item: title 必填且非空',
      'operations[0].item: publish_at 必填',
    ])
    const ok = validateChangeSet({
      operations: [{ op: 'create', client_ref: 'r1', item: { title: ' 新卡 ', publish_at: '2026/9/10 9:00' } }],
    })
    assert.deepEqual(ok.errors, [])
    assert.equal(ok.normalized[0].item.title, '新卡')
    assert.equal(ok.normalized[0].item.publish_at, '2026-09-10T09:00')
  })
  it('patch 逐字段格式校验与 patch-core 同文案', () => {
    const r = validateChangeSet({
      operations: [{ op: 'patch', item_id: 's-01', changes: { status: '进行中', roi: -1 } }],
    })
    assert.deepEqual(r.errors, [
      'operations[0].changes status 非法: "进行中"，合法值: 待执行 / 待发布 / 已发布',
      'operations[0].changes roi 须为空或非负数字，得到 "-1"',
    ])
  })
})

describe('create：排序与 id 分配', () => {
  it('同日多张新卡按 ops 顺序排入当日列尾，已有卡片顺序不动', () => {
    const r = applyChangeSet(doc(), [
      { op: 'create', item: { title: '新卡A', publish_at: '2026-09-10T10:00' } },
      { op: 'create', item: { title: '新卡B', publish_at: '2026-09-10T11:00' } },
    ])
    assert.deepEqual(r.errors, [])
    const [a, b] = r.created
    assert.equal(r.doc.orders['s-01'], 0) // 已有卡片顺序不动
    assert.equal(r.doc.orders[a.id], 1)
    assert.equal(r.doc.orders[b.id], 2)
    assert.equal(r.doc.items.length, 5)
    // 新卡落 items 末尾，缺省 type=图文 / status=待执行 / 指标 null
    const cardA = r.doc.items.find((it) => it.id === a.id)
    assert.equal(cardA.type, '图文')
    assert.equal(cardA.status, '待执行')
    assert.equal(cardA.roi, null)
  })
  it('client_ref → id 映射按 ops 顺序返回；同一内容重试 id 不变（确定性哈希）', () => {
    const ops = [
      { op: 'create', client_ref: 'row-1', item: { title: '新卡A', publish_at: '2026-09-10T10:00' } },
      { op: 'patch', item_id: 's-02', changes: { comment: '回填完成' } },
      { op: 'create', client_ref: 'row-2', item: { title: '新卡B', publish_at: '2026-09-12T09:00' } },
    ]
    const r1 = applyChangeSet(doc(), ops)
    const r2 = applyChangeSet(doc(), ops)
    assert.deepEqual(r1.created.map((c) => c.client_ref), ['row-1', 'row-2'])
    assert.equal(r1.created[0].id, r2.created[0].id)
    assert.equal(r1.created[1].id, r2.created[1].id)
    assert.match(r1.created[0].id, /^auto-[0-9a-f]{16}$/)
    // patch 不进 created 映射
    assert.equal(r1.created.length, 2)
  })
  it('create 显式 status=已发布 + 指标同帧保留；缺省待执行带指标被 gate 清空', () => {
    const r = applyChangeSet(doc(), [
      {
        op: 'create',
        item: { title: '已发新卡', publish_at: '2026-09-10T12:00', status: '已发布', roi: 2.5, engagement_4h: 88 },
      },
      { op: 'create', item: { title: '待发新卡', publish_at: '2026-09-10T13:00', roi: 9.9 } },
    ])
    assert.deepEqual(r.errors, [])
    const [published, draft] = r.created.map((c) => r.doc.items.find((it) => it.id === c.id))
    assert.equal(published.roi, 2.5)
    assert.equal(published.engagement_4h, 88)
    assert.equal(draft.status, '待执行')
    assert.equal(draft.roi, null)
  })
})

describe('patch：复用 applyItemPatch 校验与联动', () => {
  it('跨日 publish_at → 目标日列尾（运行态 nextOrder），同日时分不动 orders', () => {
    const r = applyChangeSet(doc(), [
      { op: 'patch', item_id: 's-01', changes: { publish_at: '2026-09-11T12:00' } },
      { op: 'patch', item_id: 's-02', changes: { publish_at: '2026-09-11T09:00' } },
    ])
    assert.deepEqual(r.errors, [])
    assert.equal(r.doc.orders['s-01'], 2) // 目标列 0/1 → 列尾 2
    assert.equal(r.doc.orders['s-02'], 0) // 同日时分变更顺序不变
    assert.deepEqual(
      r.changes.filter((c) => c.field === 'publish_at').map((c) => [c.item_id, c.old_value, c.new_value]),
      [
        ['s-01', '2026-09-10T09:00', '2026-09-11T12:00'],
        ['s-02', '2026-09-11T08:00', '2026-09-11T09:00'],
      ],
    )
  })
  it('指标 gate：patch status≠已发布清空三指标并进变更记录', () => {
    const r = applyChangeSet(doc(), [{ op: 'patch', item_id: 's-01', changes: { status: '待执行' } }])
    assert.deepEqual(r.errors, [])
    const next = r.doc.items.find((it) => it.id === 's-01')
    assert.equal(next.status, '待执行')
    assert.equal(next.roi, null)
    assert.equal(next.propagation_4h, null)
    assert.equal(next.engagement_4h, null)
    assert.deepEqual(
      r.changes.map((c) => c.field),
      ['status', 'roi', 'propagation_4h', 'engagement_4h'],
    )
  })
  it('同帧 status=已发布 + 指标 → 保留', () => {
    const draft = item({ id: 's-09', status: '待发布', roi: null, propagation_4h: null, engagement_4h: null })
    const r = applyChangeSet(
      doc({ items: [draft], orders: { 's-09': 0 } }),
      [{ op: 'patch', item_id: 's-09', changes: { status: '已发布', roi: 3.3, propagation_4h: 5000 } }],
    )
    assert.deepEqual(r.errors, [])
    const next = r.doc.items[0]
    assert.equal(next.status, '已发布')
    assert.equal(next.roi, 3.3)
    assert.equal(next.propagation_4h, 5000)
  })
  it('patch 目标不存在 → 全批拒绝（看板零变化，不产生部分结果）', () => {
    const before = doc()
    const r = applyChangeSet(before, [
      { op: 'create', item: { title: '新卡A', publish_at: '2026-09-10T10:00' } },
      { op: 'patch', item_id: 'ghost', changes: { title: 'x' } },
    ])
    assert.deepEqual(r.errors, ['operations[1]: 卡片不存在: ghost'])
    assert.equal(r.doc, undefined)
    assert.equal(r.changes, undefined)
    assert.equal(before.items.length, 3) // 入参不被改写
  })
  it('幂等同值 patch → 无变更记录；同值 links 深比较同样无记录', () => {
    const withLinks = item({ links: [{ id: 'l1', rel: 'publish', url: 'https://x.com/p/1' }] })
    const r = applyChangeSet(doc({ items: [withLinks], orders: { 's-01': 0 } }), [
      { op: 'patch', item_id: 's-01', changes: { title: '示例卡', roi: 1.5, comment: '' } },
      {
        op: 'patch',
        item_id: 's-01',
        changes: { links: [{ id: 'l1', rel: 'publish', url: 'https://x.com/p/1' }] },
      },
    ])
    assert.deepEqual(r.errors, [])
    assert.deepEqual(r.changes, [])
  })
})

describe('负责人登记：未知姓名自动登记，整个 set 内去重后一次性并入', () => {
  it('create 与 patch 引用同一未知名 → 同一新 id，newMembers 只登记一次', () => {
    const r = applyChangeSet(doc(), [
      { op: 'create', item: { title: '新卡A', publish_at: '2026-09-10T10:00', content_owner_id: '赵六' } },
      { op: 'patch', item_id: 's-02', changes: { delivery_owner_id: '赵六' } },
    ])
    assert.deepEqual(r.errors, [])
    assert.deepEqual(r.newMembers, [{ id: 'M-1002', name: '赵六' }])
    assert.equal(r.doc.members.length, 2)
    const cardA = r.doc.items.find((it) => it.id === r.created[0].id)
    const s02 = r.doc.items.find((it) => it.id === 's-02')
    assert.equal(cardA.content_owner_id, 'M-1002')
    assert.equal(s02.delivery_owner_id, 'M-1002')
  })
  it('按姓名命中既有成员复用 id，不新增登记', () => {
    const r = applyChangeSet(doc(), [
      { op: 'patch', item_id: 's-02', changes: { content_owner_id: '林晓' } },
    ])
    assert.deepEqual(r.errors, [])
    assert.deepEqual(r.newMembers, [])
    assert.equal(r.doc.items.find((it) => it.id === 's-02').content_owner_id, 'M-1001')
  })
})

describe('容量与 id 冲突', () => {
  it('2000 张硬上限：超限全批拒绝', () => {
    const many = Array.from({ length: BOARD_ITEM_LIMIT - 1 }, (_, i) =>
      item({ id: `b-${i}`, publish_at: '2026-09-10T09:00' }),
    )
    const orders = Object.fromEntries(many.map((it, i) => [it.id, i]))
    const r = applyChangeSet(doc({ items: many, orders }), [
      { op: 'create', item: { title: 'A', publish_at: '2026-09-12T09:00' } },
      { op: 'create', item: { title: 'B', publish_at: '2026-09-12T10:00' } },
    ])
    assert.equal(r.errors.length, 1)
    assert.match(r.errors[0], /2000 张上限/)
    assert.match(r.errors[0], /当前 1999 张，本变更集新增 2 张/)
    assert.equal(r.doc, undefined)
  })
  it('恰好到 2000 张放行', () => {
    const many = Array.from({ length: BOARD_ITEM_LIMIT - 1 }, (_, i) => item({ id: `b-${i}` }))
    const orders = Object.fromEntries(many.map((it, i) => [it.id, i]))
    const r = applyChangeSet(doc({ items: many, orders }), [
      { op: 'create', item: { title: 'A', publish_at: '2026-09-12T09:00' } },
    ])
    assert.deepEqual(r.errors, [])
    assert.equal(r.doc.items.length, BOARD_ITEM_LIMIT)
  })
  it('重复 id 拒绝：create 分配的 id 与板上已有卡片撞车 → 全批拒绝', () => {
    const fields = { title: '新卡A', type: '图文', publish_at: '2026-09-10T10:00', product_id: '' }
    const clashId = newChangeSetItemId(fields, null, 0)
    const r = applyChangeSet(doc({ items: [...doc().items, item({ id: clashId })] }), [
      { op: 'create', item: { title: '新卡A', publish_at: '2026-09-10T10:00' } },
    ])
    assert.deepEqual(r.errors, [`operations[0]: id 重复: ${clashId}`])
    assert.equal(r.doc, undefined)
  })
})

describe('links（协议 §8）', () => {
  const good = [{ id: ' l1 ', rel: 'publish', url: ' https://x.com/p/1 ', platform: 'xiaohongshu' }]
  it('合法 links 随 create 写入并归一化（trim / platform 保留）', () => {
    const r = applyChangeSet(doc(), [
      { op: 'create', item: { title: '带链新卡', publish_at: '2026-09-10T10:00', links: good } },
    ])
    assert.deepEqual(r.errors, [])
    const card = r.doc.items.find((it) => it.id === r.created[0].id)
    assert.deepEqual(card.links, [{ id: 'l1', rel: 'publish', url: 'https://x.com/p/1', platform: 'xiaohongshu' }])
  })
  it('patch 缺 url / 非数组被拒绝（预校验与 commit 同文案）', () => {
    const missing = validateChangeSet({
      operations: [{ op: 'patch', item_id: 's-01', changes: { links: [{ id: 'l1', rel: 'publish' }] } }],
    })
    assert.deepEqual(missing.errors, ['operations[0].changes links[0].url 必填且非空'])
    const notArr = applyChangeSet(doc(), [
      { op: 'patch', item_id: 's-01', changes: { links: 'https://x.com' } },
    ])
    assert.equal(notArr.errors.length, 1)
    assert.match(notArr.errors[0], /links 须为数组/)
    assert.equal(notArr.doc, undefined)
  })
  it('links 置 null → 清空（空数组）并产生变更记录', () => {
    const withLinks = item({ links: [{ id: 'l1', rel: 'publish', url: 'https://x.com/p/1' }] })
    const r = applyChangeSet(doc({ items: [withLinks], orders: { 's-01': 0 } }), [
      { op: 'patch', item_id: 's-01', changes: { links: null } },
    ])
    assert.deepEqual(r.errors, [])
    assert.deepEqual(r.doc.items[0].links, [])
    assert.deepEqual(r.changes.filter((c) => c.field === 'links').length, 1)
  })
  it('import-core 归一化放行 links：随 doc 原样往返不丢字段', () => {
    const r = validateItems(
      [{ title: '带链卡', type: '图文', publish_at: '2026-09-10T09:00', links: good }],
      { isCsv: false, knownProducts: new Set(), knownMembers: new Map(), now: '2026-09-01T00:00' },
    )
    assert.deepEqual(r.skipped, [])
    assert.deepEqual(r.valid[0].links, [
      { id: 'l1', rel: 'publish', url: 'https://x.com/p/1', platform: 'xiaohongshu' },
    ])
  })
})

describe('纯函数与审计形状', () => {
  it('不改写传入的 doc / operations', () => {
    const d = doc()
    const ops = [
      { op: 'create', client_ref: 'r1', item: { title: '新卡A', publish_at: '2026-09-10T10:00' } },
      { op: 'patch', item_id: 's-01', changes: { status: '待执行', publish_at: '2026-09-11T12:00' } },
    ]
    const before = JSON.stringify({ d, ops })
    applyChangeSet(d, ops)
    assert.equal(JSON.stringify({ d, ops }), before)
  })
  it('create 的变更记录逐字段 old_value=null，含 id；patch 记录带 item_id', () => {
    const r = applyChangeSet(doc(), [
      { op: 'create', client_ref: 'r1', item: { title: '新卡A', publish_at: '2026-09-10T10:00' } },
      { op: 'patch', item_id: 's-02', changes: { comment: '回填完成' } },
    ])
    const createdChanges = r.changes.filter((c) => c.item_id === r.created[0].id)
    assert.ok(createdChanges.length >= 12)
    assert.ok(createdChanges.every((c) => c.old_value === null))
    assert.deepEqual(createdChanges[0], { item_id: r.created[0].id, field: 'id', old_value: null, new_value: r.created[0].id })
    assert.deepEqual(r.changes.filter((c) => c.item_id === 's-02'), [
      { item_id: 's-02', field: 'comment', old_value: '', new_value: '回填完成' },
    ])
  })
})
