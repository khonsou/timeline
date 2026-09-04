/**
 * @timeline/core patch-core 单测（node:test）：Agent PATCH 规则下沉后的纯函数验证。
 * 覆盖：字段白名单拒绝、逐字段校验文案、指标-状态联动（gate）、负责人解析五路径、
 * nextMemberId 边界、跨日 orders 联动、幂等同值补丁、comment/product_id 细节。
 * 语义以 packages/server PATCH 路由迁移前实现为准（2026-09 下沉）。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  METRIC_FIELDS,
  PATCH_FIELDS,
  applyItemPatch,
  nextMemberId,
  resolveOwnerPatch,
} from '@timeline/core/patch-core'

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

/** ctx：默认目标跨日列 2026-09-11 有两张卡（order 0/1），当前卡在 09-10 */
const ctx = (over = {}) => ({
  members: MEMBERS,
  items: [
    item(),
    item({ id: 's-02', publish_at: '2026-09-11T08:00' }),
    item({ id: 's-03', publish_at: '2026-09-11T10:00' }),
  ],
  orders: { 's-01': 0, 's-02': 0, 's-03': 1 },
  ...over,
})

describe('字段白名单', () => {
  it('白名单外字段被拒绝且按原序报告', () => {
    const r = applyItemPatch({ id: 'x', orders: 1, title: '新标题' }, item(), ctx())
    assert.deepEqual(r.unknownFields, ['id', 'orders'])
    assert.equal(r.next, undefined)
    assert.deepEqual(r.changes, [])
    assert.equal(r.orderUpdate, null)
  })
  it('PATCH_FIELDS 恰为 11 个字段且不含只读字段', () => {
    assert.equal(PATCH_FIELDS.length, 11)
    assert.ok(!PATCH_FIELDS.includes('id'))
    assert.ok(!PATCH_FIELDS.includes('orders'))
    assert.deepEqual([...METRIC_FIELDS], ['roi', 'propagation_4h', 'engagement_4h'])
  })
})

describe('逐字段校验与文案', () => {
  it('空 title / 非法 type / 非法 status / 非法 publish_at 按字段顺序收集', () => {
    const r = applyItemPatch(
      { title: '  ', type: '视频号', status: '进行中', publish_at: '明天上午' },
      item(),
      ctx(),
    )
    assert.deepEqual(r.errors, [
      'title 必填且非空',
      'type 非法: "视频号"，合法值: 图文 / 视频 / 音频 / 直播 / 数据',
      'status 非法: "进行中"，合法值: 待执行 / 待发布 / 已发布',
      'publish_at 无法解析: "明天上午"（接受 YYYY-MM-DDTHH:mm / YYYY-MM-DD HH:mm / YYYY/M/D H:mm）',
    ])
    assert.equal(r.next, undefined)
  })
  it('指标负数与非数字报错，空值归一为 null', () => {
    const bad = applyItemPatch({ roi: -1, propagation_4h: 'abc' }, item(), ctx())
    assert.deepEqual(bad.errors, [
      'roi 须为空或非负数字，得到 "-1"',
      'propagation_4h 须为空或非负数字，得到 "abc"',
    ])
    const ok = applyItemPatch({ roi: '', propagation_4h: null }, item(), ctx())
    assert.equal(ok.errors.length, 0)
    assert.equal(ok.next.roi, null)
    assert.equal(ok.next.propagation_4h, null)
    // '' / null → null，与原值 1.5 / 100 不同 → 进 changes
    assert.deepEqual(
      ok.changes.map((c) => c.field),
      ['roi', 'propagation_4h'],
    )
  })
})

describe('指标-状态联动（gate）', () => {
  it('已发布带指标卡改 status → 待执行：三指标强制 null 且全部进 changes', () => {
    const r = applyItemPatch({ status: '待执行' }, item(), ctx())
    assert.equal(r.next.status, '待执行')
    assert.equal(r.next.roi, null)
    assert.equal(r.next.propagation_4h, null)
    assert.equal(r.next.engagement_4h, null)
    assert.deepEqual(
      r.changes.map((c) => c.field),
      ['status', 'roi', 'propagation_4h', 'engagement_4h'],
    )
  })
  it('边界：待发布卡只 PATCH roi=9.9 → 被强制 null 且不进 changes（原值本为 null）', () => {
    const draft = item({ status: '待发布', roi: null, propagation_4h: null, engagement_4h: null })
    const r = applyItemPatch({ roi: 9.9 }, draft, ctx({ items: [draft] }))
    assert.equal(r.next.roi, null)
    assert.deepEqual(r.changes, [])
  })
  it('解锁：status → 已发布时同补丁 roi=3.3 被保留', () => {
    const draft = item({ status: '待发布', roi: null, propagation_4h: null, engagement_4h: null })
    const r = applyItemPatch({ status: '已发布', roi: 3.3 }, draft, ctx({ items: [draft] }))
    assert.equal(r.next.status, '已发布')
    assert.equal(r.next.roi, 3.3)
    assert.deepEqual(
      r.changes.map((c) => c.field),
      ['status', 'roi'],
    )
  })
})

describe('负责人解析 resolveOwnerPatch', () => {
  it('空值 → 未分配空串', () => {
    assert.deepEqual(resolveOwnerPatch('', MEMBERS), { id: '' })
    assert.deepEqual(resolveOwnerPatch(null, MEMBERS), { id: '' })
  })
  it('按 id 命中 → 原样返回', () => {
    assert.deepEqual(resolveOwnerPatch('M-1001', MEMBERS), { id: 'M-1001' })
  })
  it('按姓名命中 → 复用其 id', () => {
    assert.deepEqual(resolveOwnerPatch('林晓', MEMBERS), { id: 'M-1001' })
  })
  it('未知姓名 → 登记新成员并返回新 id', () => {
    const r = resolveOwnerPatch('赵六', MEMBERS)
    assert.equal(r.id, 'M-1002')
    assert.deepEqual(r.registered, { id: 'M-1002', name: '赵六' })
  })
  it('同一 PATCH 两个字段同一未知名 → 同一新 id 且 pendingMembers 只登记一次', () => {
    const r = applyItemPatch(
      { content_owner_id: '赵六', delivery_owner_id: '赵六' },
      item({ content_owner_id: 'M-1001' }),
      ctx(),
    )
    assert.equal(r.next.content_owner_id, 'M-1002')
    assert.equal(r.next.delivery_owner_id, 'M-1002')
    assert.equal(r.pendingMembers.length, 1)
    assert.deepEqual(r.pendingMembers[0], { id: 'M-1002', name: '赵六' })
  })
  it('PATCH 中空串负责人不产生变化', () => {
    const r = applyItemPatch({ delivery_owner_id: '' }, item(), ctx())
    assert.deepEqual(r.changes, [])
    assert.deepEqual(r.pendingMembers, [])
  })
})

describe('nextMemberId 边界', () => {
  it('空目录 → M-1001', () => {
    assert.equal(nextMemberId([]), 'M-1001')
  })
  it('取数字后缀 max+1 并四位补齐', () => {
    assert.equal(nextMemberId([{ id: 'M-1009', name: 'a' }]), 'M-1010')
    assert.equal(nextMemberId([{ id: 'M-1001', name: 'a' }, { id: 'M-1003', name: 'b' }]), 'M-1004')
  })
  it('无数字后缀的 id 被忽略', () => {
    assert.equal(nextMemberId([{ id: 'admin', name: 'a' }]), 'M-1001')
  })
})

describe('跨日 orders 联动', () => {
  it('跨日移动 → 排到目标日列末尾（目标列 2 卡 order 0/1 → 新 order 2）', () => {
    const r = applyItemPatch({ publish_at: '2026-09-11T12:00' }, item(), ctx())
    assert.deepEqual(r.orderUpdate, { id: 's-01', order: 2 })
  })
  it('目标列为空 → order 0', () => {
    const r = applyItemPatch({ publish_at: '2026-09-12T12:00' }, item(), ctx())
    assert.deepEqual(r.orderUpdate, { id: 's-01', order: 0 })
  })
  it('同日时分变更 → 不动 orders（orderUpdate 为 null）', () => {
    const r = applyItemPatch({ publish_at: '2026-09-10T18:30' }, item(), ctx())
    assert.equal(r.orderUpdate, null)
    assert.deepEqual(
      r.changes.map((c) => c.field),
      ['publish_at'],
    )
  })
  it('publish_at 接受空格/斜杠格式并归一化后判定跨日', () => {
    const r = applyItemPatch({ publish_at: '2026/9/11 12:00' }, item(), ctx())
    assert.equal(r.next.publish_at, '2026-09-11T12:00')
    assert.deepEqual(r.orderUpdate, { id: 's-01', order: 2 })
  })
})

describe('幂等与细节', () => {
  it('同值补丁 → changes 为空（幂等，无审计）', () => {
    const r = applyItemPatch({ title: '示例卡', roi: 1.5, comment: '' }, item(), ctx())
    assert.deepEqual(r.changes, [])
    assert.equal(r.orderUpdate, null)
  })
  it('comment 不 trim、product_id 仅 trim 且不登记目录', () => {
    const r = applyItemPatch({ comment: '  保留空格  ', product_id: '  P-9999  ' }, item(), ctx())
    assert.equal(r.next.comment, '  保留空格  ')
    assert.equal(r.next.product_id, 'P-9999')
    assert.deepEqual(r.pendingMembers, [])
    assert.deepEqual(
      r.changes.map((c) => c.field),
      ['product_id', 'comment'],
    )
  })
  it('纯函数：不改写传入的 item / members / orders', () => {
    const it0 = item()
    const c0 = ctx()
    const membersBefore = JSON.stringify(c0.members)
    const ordersBefore = JSON.stringify(c0.orders)
    applyItemPatch({ status: '待执行', publish_at: '2026-09-11T12:00' }, it0, c0)
    assert.equal(it0.status, '已发布')
    assert.equal(it0.roi, 1.5)
    assert.equal(JSON.stringify(c0.members), membersBefore)
    assert.equal(JSON.stringify(c0.orders), ordersBefore)
  })
})
