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
  it('op 仅允许 create / patch / group_* 五种（统一分组模型无 group_mode）', () => {
    const r = validateChangeSet({ operations: [{ op: 'delete', item_id: 's-01' }] })
    assert.deepEqual(r.errors, [
      'operations[0].op 非法: "delete"，合法值: create / patch / group_create / group_patch / group_delete',
    ])
    // group_mode 已随双模式方案废弃
    const old = validateChangeSet({ operations: [{ op: 'group_mode', mode: 'custom' }] })
    assert.match(old.errors[0], /op 非法: "group_mode"/)
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
  it('改期跨列（写入时归属解析）→ 目标日期组列尾；同日时分不动 orders 也不动分组', () => {
    // 统一分组模型：列 = group_id；09-10/09-11 为同名日期组
    const d = doc({
      groups: [
        { id: 'g-0910', name: '2026-09-10' },
        { id: 'g-0911', name: '2026-09-11' },
      ],
      items: [
        item({ group_id: 'g-0910' }),
        item({ id: 's-02', publish_at: '2026-09-11T08:00', group_id: 'g-0911' }),
        item({ id: 's-03', publish_at: '2026-09-11T10:00', group_id: 'g-0911' }),
      ],
    })
    const r = applyChangeSet(d, [
      { op: 'patch', item_id: 's-01', changes: { publish_at: '2026-09-11T12:00' } },
      { op: 'patch', item_id: 's-02', changes: { publish_at: '2026-09-11T09:00' } },
    ])
    assert.deepEqual(r.errors, [])
    assert.equal(r.doc.items.find((it) => it.id === 's-01').group_id, 'g-0911') // 挂入同名日期组
    assert.equal(r.doc.orders['s-01'], 2) // 目标列 0/1 → 列尾 2
    assert.equal(r.doc.orders['s-02'], 0) // 同日时分变更顺序不变
    assert.equal(r.doc.items.find((it) => it.id === 's-02').group_id, 'g-0911') // 时分变更不动分组
    assert.deepEqual(
      r.changes.filter((c) => c.field === 'publish_at').map((c) => [c.item_id, c.old_value, c.new_value]),
      [
        ['s-01', '2026-09-10T09:00', '2026-09-11T12:00'],
        ['s-02', '2026-09-11T08:00', '2026-09-11T09:00'],
      ],
    )
    // 无同名日期组 → 归未分组（移除 group_id），order 取未分组列尾
    const r2 = applyChangeSet(d, [{ op: 'patch', item_id: 's-01', changes: { publish_at: '2026-12-01T12:00' } }])
    assert.deepEqual(r2.errors, [])
    assert.ok(!('group_id' in r2.doc.items.find((it) => it.id === 's-01')))
    assert.equal(r2.doc.orders['s-01'], 0) // 未分组列原本为空
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

describe('v2-M1b：bg_color(hex) / dimmed 经 change-set（agent 写入口）', () => {
  it('patch 无 bg_color/dimmed 的旧卡：old_value 为 undefined（server 审计需容错），hex 生效', () => {
    const r = applyChangeSet(doc(), [
      { op: 'patch', item_id: 's-01', changes: { bg_color: '#8B5CF6', dimmed: true } },
    ])
    assert.deepEqual(r.errors, [])
    assert.equal(r.doc.items[0].bg_color, '#8b5cf6') // 大写归一化为小写
    assert.equal(r.doc.items[0].dimmed, true)
    const bgChange = r.changes.find((c) => c.field === 'bg_color')
    assert.equal(bgChange.old_value, undefined)
    assert.equal(bgChange.new_value, '#8b5cf6')
  })
  it('patch 旧色板 token 归一化为 hex 再存（向后兼容）', () => {
    const r = applyChangeSet(doc(), [
      { op: 'patch', item_id: 's-01', changes: { bg_color: 'violet' } },
    ])
    assert.deepEqual(r.errors, [])
    assert.equal(r.doc.items[0].bg_color, '#8b5cf6')
  })
  it('patch 非法色值 / 非 boolean 被拒绝（与 PATCH 同文案）', () => {
    const r = validateChangeSet({
      operations: [{ op: 'patch', item_id: 's-01', changes: { bg_color: 'pink' } }],
    })
    assert.equal(r.errors.length, 1)
    assert.match(r.errors[0], /bg_color 非法/)
    const r2 = validateChangeSet({
      operations: [{ op: 'patch', item_id: 's-01', changes: { dimmed: 'yes' } }],
    })
    assert.equal(r2.errors.length, 1)
    assert.match(r2.errors[0], /dimmed 非法: 期望 boolean/)
  })
  it('patch 清除：bg_color=null 移除字段，dimmed=false 移除字段', () => {
    const d = doc({ items: [item({ bg_color: '#f59e0b', dimmed: true })], orders: { 's-01': 0 } })
    const r = applyChangeSet(d, [
      { op: 'patch', item_id: 's-01', changes: { bg_color: null, dimmed: false } },
    ])
    assert.deepEqual(r.errors, [])
    assert.equal('bg_color' in r.doc.items[0], false)
    assert.equal('dimmed' in r.doc.items[0], false)
  })
  it('create 带 bg_color(hex/token)/dimmed：归一化后保留入 doc（不再静默丢弃）', () => {
    const r = applyChangeSet(doc(), [
      {
        op: 'create',
        client_ref: 'm1-new',
        item: { title: 'agent 新卡', publish_at: '2026-09-12T10:00', bg_color: '#22c55e', dimmed: true },
      },
      {
        op: 'create',
        client_ref: 'm1-token',
        item: { title: '旧 token 卡', publish_at: '2026-09-12T11:00', bg_color: 'green' },
      },
    ])
    assert.deepEqual(r.errors, [])
    const created = r.doc.items.find((it) => it.id === r.created[0].id)
    assert.equal(created.bg_color, '#22c55e')
    assert.equal(created.dimmed, true)
    const created2 = r.doc.items.find((it) => it.id === r.created[1].id)
    assert.equal(created2.bg_color, '#22c55e') // token 'green' 收敛为 hex
  })
  it('create 非法 bg_color / dimmed 被拒绝；dimmed=false 不写字段', () => {
    const bad = validateChangeSet({
      operations: [{ op: 'create', item: { title: 'x', publish_at: '2026-09-12T10:00', bg_color: 'pink' } }],
    })
    assert.equal(bad.errors.length, 1)
    assert.match(bad.errors[0], /bg_color 非法/)
    const bad2 = validateChangeSet({
      operations: [{ op: 'create', item: { title: 'x', publish_at: '2026-09-12T10:00', dimmed: 1 } }],
    })
    assert.equal(bad2.errors.length, 1)
    assert.match(bad2.errors[0], /dimmed 非法: 期望 boolean/)
    const r = applyChangeSet(doc(), [
      { op: 'create', item: { title: 'x', publish_at: '2026-09-12T10:00', dimmed: false } },
    ])
    const created = r.doc.items.find((it) => it.id === r.created[0].id)
    assert.equal('dimmed' in created, false)
  })
})

describe('v2-M2 F3 统一分组模型：3 个 doc 级 op', () => {
  const gdoc = (over = {}) =>
    doc({
      groups: [
        { id: 'grp-a', name: 'A 组' },
        { id: 'grp-b', name: 'B 组' },
      ],
      ...over,
    })

  it('group_create：确定性 id + client_ref 映射；同 set 重试幂等', () => {
    const ops = [{ op: 'group_create', client_ref: 'g1', group: { name: ' 测试阶段 ' } }]
    const r1 = applyChangeSet(doc(), ops)
    const r2 = applyChangeSet(doc(), ops)
    assert.deepEqual(r1.errors, [])
    assert.equal(r1.doc.groups.length, 1)
    assert.equal(r1.doc.groups[0].name, '测试阶段') // trim
    assert.match(r1.doc.groups[0].id, /^grp-[0-9a-f]{16}$/)
    assert.equal(r1.doc.groups[0].id, r2.doc.groups[0].id) // 确定性哈希
    assert.deepEqual(r1.createdGroups, [{ client_ref: 'g1', id: r1.doc.groups[0].id }])
  })
  it('group_create：分组满 61 → 全批拒绝（虚拟「未分组」列不占名额）', () => {
    const full = doc({
      groups: Array.from({ length: 61 }, (_, i) => ({ id: `grp-${i}`, name: `G${i}` })),
    })
    const r = applyChangeSet(full, [{ op: 'group_create', group: { name: '第 62 组' } }])
    assert.equal(r.errors.length, 1)
    assert.match(r.errors[0], /分组已达上限 61 个/)
    assert.equal(r.doc, undefined)
    // 60 个时可建第 61 个
    const almost = doc({
      groups: Array.from({ length: 60 }, (_, i) => ({ id: `grp-${i}`, name: `G${i}` })),
    })
    const ok = applyChangeSet(almost, [{ op: 'group_create', group: { name: '第 61 组' } }])
    assert.deepEqual(ok.errors, [])
    assert.equal(ok.doc.groups.length, 61)
  })
  it('预校验：空 name / 空 client_ref / move_to 空串 / group_patch 缺 name 与 before_group_id', () => {
    const r = validateChangeSet({
      operations: [
        { op: 'group_create', group: { name: '  ' } },
        { op: 'group_create', client_ref: ' ', group: { name: 'x' } },
        { op: 'group_delete', group_id: 'grp-a', move_to: ' ' },
        { op: 'group_patch', group_id: 'grp-a', changes: {} },
        { op: 'group_delete', group_id: ' ' },
      ],
    })
    assert.deepEqual(r.errors, [
      'operations[0].group.name 必填且非空',
      'operations[1].client_ref 须为非空字符串',
      'operations[2].move_to 须为非空字符串（目标分组 id / 同 set client_ref）',
      'operations[3].changes 须含 name 或 before_group_id',
      'operations[4].group_id 必填且非空',
    ])
  })
  it('set 内先建后引用：group_create 的 client_ref 被后续 create/patch 的 group_id 引用', () => {
    const r = applyChangeSet(doc(), [
      { op: 'group_create', client_ref: 'g-new', group: { name: '新阶段' } },
      { op: 'create', item: { title: '新卡', publish_at: '2026-09-12T09:00', group_id: 'g-new' } },
      { op: 'patch', item_id: 's-01', changes: { group_id: 'g-new' } },
    ])
    assert.deepEqual(r.errors, [])
    const gid = r.createdGroups[0].id
    const card = r.doc.items.find((it) => it.id === r.created[0].id)
    assert.equal(card.group_id, gid)
    assert.equal(r.doc.items.find((it) => it.id === 's-01').group_id, gid)
  })
  it('写入严格：patch/create 引用不存在分组（且非同 set 新建）→ 全批拒绝', () => {
    const r = applyChangeSet(doc(), [
      { op: 'create', item: { title: '新卡', publish_at: '2026-09-12T09:00', group_id: 'grp-ghost' } },
      { op: 'patch', item_id: 's-01', changes: { group_id: 'grp-ghost' } },
    ])
    assert.equal(r.errors.length, 2)
    assert.match(r.errors[0], /group_id 不存在: "grp-ghost"/)
    assert.match(r.errors[1], /group_id 不存在: "grp-ghost"/)
    assert.equal(r.doc, undefined)
    // 预校验放行（存在性检查在 commit，与负责人姓名同一分层）
    assert.deepEqual(
      validateChangeSet({ operations: [{ op: 'patch', item_id: 's-01', changes: { group_id: 'grp-ghost' } }] }).errors,
      [],
    )
  })
  it('group_patch：重命名 + 调列序（before_group_id / null=末尾）；幂等无变更记录', () => {
    const r = applyChangeSet(gdoc(), [
      { op: 'group_patch', group_id: 'grp-a', changes: { name: 'A 组·改' } },
      { op: 'group_patch', group_id: 'grp-b', changes: { before_group_id: 'grp-a' } },
    ])
    assert.deepEqual(r.errors, [])
    assert.deepEqual(
      r.doc.groups.map((g) => [g.id, g.name]),
      [
        ['grp-b', 'B 组'],
        ['grp-a', 'A 组·改'],
      ],
    )
    // null = 移到末尾
    const r2 = applyChangeSet(gdoc(), [{ op: 'group_patch', group_id: 'grp-a', changes: { before_group_id: null } }])
    assert.deepEqual(r2.doc.groups.map((g) => g.id), ['grp-b', 'grp-a'])
    // 幂等：同名 / 同位置不产生变更记录
    const r3 = applyChangeSet(gdoc(), [
      { op: 'group_patch', group_id: 'grp-a', changes: { name: 'A 组', before_group_id: 'grp-b' } },
    ])
    assert.deepEqual(r3.errors, [])
    assert.deepEqual(r3.changes, [])
    // before_group_id 指向自身 / 不存在 → 拒绝
    const r4 = applyChangeSet(gdoc(), [
      { op: 'group_patch', group_id: 'grp-a', changes: { before_group_id: 'grp-a' } },
    ])
    assert.match(r4.errors[0], /不能是被移动分组自身/)
  })
  it('group_delete：move_to 可缺省 = 归未分组；显式 move_to 迁移组内卡片', () => {
    const d = gdoc({
      items: [item({ group_id: 'grp-a' }), item({ id: 's-02', group_id: 'grp-a' }), item({ id: 's-03', group_id: 'grp-b' })],
    })
    // 缺省 move_to：非空组直接删，组内卡片归「未分组」（移除 group_id 字段）
    const toUngrouped = applyChangeSet(d, [{ op: 'group_delete', group_id: 'grp-a' }])
    assert.deepEqual(toUngrouped.errors, [])
    assert.deepEqual(toUngrouped.doc.groups.map((g) => g.id), ['grp-b'])
    assert.ok(toUngrouped.doc.items.every((it) => !('group_id' in it) || it.group_id === 'grp-b'))
    assert.equal(toUngrouped.doc.items.filter((it) => !('group_id' in it)).length, 2)
    // move_to 指向自身 / 不存在 → 拒绝
    const self = applyChangeSet(d, [{ op: 'group_delete', group_id: 'grp-a', move_to: 'grp-a' }])
    assert.match(self.errors[0], /move_to 不能是被删分组自身/)
    const ghost = applyChangeSet(d, [{ op: 'group_delete', group_id: 'grp-a', move_to: 'grp-ghost' }])
    assert.match(ghost.errors[0], /move_to 分组不存在/)
    // 合法迁移
    const ok = applyChangeSet(d, [{ op: 'group_delete', group_id: 'grp-a', move_to: 'grp-b' }])
    assert.deepEqual(ok.errors, [])
    assert.deepEqual(ok.doc.groups.map((g) => g.id), ['grp-b'])
    assert.ok(ok.doc.items.every((it) => it.group_id === 'grp-b'))
  })
  it('create 写入时归属解析：同名日期组挂入 / 无同名组留未分组（不自动建组）/ 显式 null 优先', () => {
    const d = doc({
      groups: [
        { id: 'g-0912', name: '2026-09-12' },
        { id: 'g-x', name: '测试阶段' },
      ],
    })
    const r = applyChangeSet(d, [
      { op: 'create', item: { title: 'A', publish_at: '2026-09-12T09:00' } },
      { op: 'create', item: { title: 'B', publish_at: '2026-09-13T09:00' } },
      { op: 'create', item: { title: 'C', publish_at: '2026-09-12T10:00', group_id: null } },
      { op: 'create', item: { title: 'D', publish_at: '2026-09-12T11:00', group_id: 'g-x' } },
    ])
    assert.deepEqual(r.errors, [])
    const [a, b, c, d4] = r.created.map((x) => r.doc.items.find((it) => it.id === x.id))
    assert.equal(a.group_id, 'g-0912') // 组名 == publish_at 日期 → 挂入
    assert.ok(!('group_id' in b)) // 无同名日期组 → 未分组（groups 不膨胀）
    assert.equal(r.doc.groups.length, 2)
    assert.ok(!('group_id' in c)) // 显式 null = 归未分组（即使有同名日期组）
    assert.equal(d4.group_id, 'g-x') // 显式分组优先于日期解析
  })
  it('patch group_id null = 归未分组（移除语义，经 commit 保留 null 键入库再应用）', () => {
    const d = gdoc({ items: [item({ group_id: 'grp-a' })] })
    const v = validateChangeSet({ operations: [{ op: 'patch', item_id: 's-01', changes: { group_id: null } }] })
    assert.deepEqual(v.errors, [])
    assert.equal(v.normalized[0].changes.group_id, null) // 移除语义入库不丢键
    const r = applyChangeSet(d, v.normalized)
    assert.deepEqual(r.errors, [])
    assert.ok(!('group_id' in r.doc.items[0]))
  })
})

// ---------------------------------------------------------------------------
// v2-M3 F4 卡片关系：change-set create/patch 的 pre_ids 与 PATCH 同口径；
// post_ids 镜像同事务维护；post_ids 直接写入 → 白名单外拒绝
// ---------------------------------------------------------------------------
describe('v2-M3 pre_ids / post_ids（change-set 同口径）', () => {
  it('预校验：post_ids 不支持；pre_ids 格式校验；空数组清空语义保留', () => {
    const bad = validateChangeSet({ operations: [{ op: 'patch', item_id: 's-01', changes: { post_ids: ['s-02'] } }] })
    assert.match(bad.errors[0], /不支持修改的字段: post_ids/)
    const badFmt = validateChangeSet({ operations: [{ op: 'patch', item_id: 's-01', changes: { pre_ids: 'x' } }] })
    assert.match(badFmt.errors[0], /pre_ids 非法/)
    const ok = validateChangeSet({ operations: [{ op: 'patch', item_id: 's-01', changes: { pre_ids: [] } }] })
    assert.deepEqual(ok.errors, [])
    assert.deepEqual(ok.normalized[0].changes.pre_ids, []) // 空数组清空语义不丢键
  })
  it('patch pre_ids → 写入 + 被引用卡 post_ids 镜像 + 审计两条', () => {
    const r = applyChangeSet(doc(), [
      { op: 'patch', item_id: 's-01', changes: { pre_ids: ['s-02', 's-03'] } },
    ])
    assert.deepEqual(r.errors, [])
    const a = r.doc.items.find((it) => it.id === 's-01')
    assert.deepEqual(a.pre_ids, ['s-02', 's-03'])
    assert.deepEqual(r.doc.items.find((it) => it.id === 's-02').post_ids, ['s-01'])
    assert.deepEqual(r.doc.items.find((it) => it.id === 's-03').post_ids, ['s-01'])
    const mirrorAudit = r.changes.filter((c) => c.field === 'post_ids')
    assert.equal(mirrorAudit.length, 2)
  })
  it('patch pre_ids 悬空 / 自环 → 全批拒绝零变化', () => {
    const ghost = applyChangeSet(doc(), [{ op: 'patch', item_id: 's-01', changes: { pre_ids: ['ghost'] } }])
    assert.match(ghost.errors[0], /pre_ids 指向不存在的卡片/)
    assert.equal(ghost.doc, undefined)
    const self = applyChangeSet(doc(), [{ op: 'patch', item_id: 's-01', changes: { pre_ids: ['s-01'] } }])
    assert.match(self.errors[0], /不允许自环/)
  })
  it('create 携带 pre_ids → 新卡落字段 + 旧卡镜像；引用同 set 前序新建卡可见', () => {
    const r = applyChangeSet(doc(), [
      { op: 'create', client_ref: 'n1', item: { title: '新卡', publish_at: '2026-09-12T09:00', pre_ids: ['s-02'] } },
    ])
    assert.deepEqual(r.errors, [])
    const createdId = r.created[0].id
    const created = r.doc.items.find((it) => it.id === createdId)
    assert.deepEqual(created.pre_ids, ['s-02'])
    assert.deepEqual(r.doc.items.find((it) => it.id === 's-02').post_ids, [createdId])
    // 同 set 先建后引用：第二张卡引用第一张的服务端分配 id
    const first = r.created[0].id
    const r2 = applyChangeSet(doc(), [
      { op: 'create', client_ref: 'n1', item: { title: '新卡', publish_at: '2026-09-12T09:00' } },
      { op: 'create', client_ref: 'n2', item: { title: '新卡2', publish_at: '2026-09-12T10:00', pre_ids: [newChangeSetItemId({ title: '新卡', type: '图文', publish_at: '2026-09-12T09:00', product_id: '' }, 'n1', 0)] } },
    ])
    assert.deepEqual(r2.errors, [])
    assert.deepEqual(r2.doc.items.find((it) => it.id === r2.created[1].id).pre_ids, [first])
    assert.deepEqual(r2.doc.items.find((it) => it.id === first).post_ids, [r2.created[1].id])
    // create 引用不存在卡 → 全批拒绝
    const bad = applyChangeSet(doc(), [
      { op: 'create', item: { title: 'x', publish_at: '2026-09-12T09:00', pre_ids: ['ghost'] } },
    ])
    assert.match(bad.errors[0], /pre_ids 指向不存在的卡片/)
  })
})
