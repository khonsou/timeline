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
  it('PATCH_FIELDS 恰为 15 个字段且不含只读字段（v19+ 追加 links；v2-M1 追加 bg_color/dimmed；v2-M2 追加 group_id）', () => {
    assert.equal(PATCH_FIELDS.length, 15)
    assert.ok(PATCH_FIELDS.includes('links'))
    assert.ok(PATCH_FIELDS.includes('bg_color'))
    assert.ok(PATCH_FIELDS.includes('dimmed'))
    assert.ok(PATCH_FIELDS.includes('group_id'))
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

describe('跨列 orders 联动（v2-M2 统一分组模型：列 = group_id；改期走写入时归属解析）', () => {
  const DATE_GROUPS = [
    { id: 'g-0910', name: '2026-09-10' },
    { id: 'g-0911', name: '2026-09-11' },
  ]
  /** 卡 s-01 在 09-10 组；09-11 组有 s-02/s-03（order 0/1） */
  const gctx = (over = {}) =>
    ctx({
      groups: DATE_GROUPS,
      items: [
        item({ group_id: 'g-0910' }),
        item({ id: 's-02', publish_at: '2026-09-11T08:00', group_id: 'g-0911' }),
        item({ id: 's-03', publish_at: '2026-09-11T10:00', group_id: 'g-0911' }),
      ],
      ...over,
    })
  it('改期 → 存在同名日期组则挂入，并排目标列末尾（order 0/1 → 新 order 2）', () => {
    const r = applyItemPatch({ publish_at: '2026-09-11T12:00' }, item({ group_id: 'g-0910' }), gctx())
    assert.equal(r.next.group_id, 'g-0911')
    assert.deepEqual(r.orderUpdate, { id: 's-01', order: 2 })
  })
  it('改期 → 无同名日期组则归未分组（移除 group_id，绝不自动建组），order 取未分组列尾', () => {
    const r = applyItemPatch({ publish_at: '2026-09-12T12:00' }, item({ group_id: 'g-0910' }), gctx())
    assert.ok(!('group_id' in r.next))
    assert.deepEqual(r.orderUpdate, { id: 's-01', order: 0 })
  })
  it('同日时分变更 → 不触发归属解析、不动 orders（orderUpdate 为 null）', () => {
    const r = applyItemPatch({ publish_at: '2026-09-10T18:30' }, item({ group_id: 'g-0910' }), gctx())
    assert.equal(r.orderUpdate, null)
    assert.equal(r.next.group_id, 'g-0910')
    assert.deepEqual(
      r.changes.map((c) => c.field),
      ['publish_at'],
    )
  })
  it('publish_at 接受空格/斜杠格式并归一化后判定跨列', () => {
    const r = applyItemPatch({ publish_at: '2026/9/11 12:00' }, item({ group_id: 'g-0910' }), gctx())
    assert.equal(r.next.publish_at, '2026-09-11T12:00')
    assert.equal(r.next.group_id, 'g-0911')
    assert.deepEqual(r.orderUpdate, { id: 's-01', order: 2 })
  })
  it('显式 group_id 优先于日期归属解析（同传 publish_at 时以显式值为准）', () => {
    const r = applyItemPatch(
      { publish_at: '2026-09-11T12:00', group_id: 'g-0910' },
      item({ group_id: 'g-0910' }),
      gctx(),
    )
    assert.deepEqual(r.errors, [])
    assert.equal(r.next.group_id, 'g-0910')
    assert.equal(r.orderUpdate, null) // 列未变
  })
  it('ctx 缺省 groups（预校验分层）→ 不做归属解析也不动 orders', () => {
    const r = applyItemPatch({ publish_at: '2026-09-11T12:00' }, item(), ctx())
    assert.deepEqual(r.errors, [])
    assert.ok(!('group_id' in r.next))
    assert.equal(r.orderUpdate, null)
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

describe('bg_color（v2-M1b F1：卡片自有 hex 属性）', () => {
  it('hex 写入并归一化为小写 #rrggbb（#rgb 展开、大写转小写）', () => {
    const r = applyItemPatch({ bg_color: '#F59E0B' }, item(), ctx())
    assert.deepEqual(r.errors, [])
    assert.equal(r.next.bg_color, '#f59e0b')
    assert.deepEqual(r.changes, [{ field: 'bg_color', old_value: undefined, new_value: '#f59e0b' }])
    const r2 = applyItemPatch({ bg_color: '#AbC' }, item(), ctx())
    assert.equal(r2.next.bg_color, '#aabbcc')
  })
  it('旧色板 token 写入时归一化为对应 hex（向后兼容，数据收敛为 hex）', () => {
    const r = applyItemPatch({ bg_color: 'sky' }, item(), ctx())
    assert.deepEqual(r.errors, [])
    assert.equal(r.next.bg_color, '#0ea5e9')
    const r2 = applyItemPatch({ bg_color: ' Amber ' }, item(), ctx())
    assert.equal(r2.next.bg_color, '#f59e0b')
  })
  it('非法值报错且拒绝写入', () => {
    for (const bad of ['pink', '#12345', '#gggggg', 'rgb(1,2,3)']) {
      const r = applyItemPatch({ bg_color: bad }, item(), ctx())
      assert.deepEqual(r.errors, [
        `bg_color 非法: "${bad}"，合法值: #rgb / #rrggbb 十六进制色值`,
      ])
      assert.equal(r.next, undefined)
    }
  })
  it('null / 空串 / undefined → 移除字段（恢复默认）', () => {
    const colored = item({ bg_color: '#ef4444' })
    for (const v of [null, '', '  ', undefined]) {
      const r = applyItemPatch({ bg_color: v }, colored, ctx())
      assert.deepEqual(r.errors, [])
      assert.ok(!('bg_color' in r.next), `bg_color=${String(v)} 应移除字段`)
      assert.deepEqual(r.changes, [
        { field: 'bg_color', old_value: '#ef4444', new_value: undefined },
      ])
    }
  })
  it('同值补丁幂等（无 changes）；token 与已存 hex 同值也幂等；本来无色时清除无 changes', () => {
    const r1 = applyItemPatch({ bg_color: '#0EA5E9' }, item({ bg_color: '#0ea5e9' }), ctx())
    assert.deepEqual(r1.changes, [])
    const r2 = applyItemPatch({ bg_color: 'sky' }, item({ bg_color: '#0ea5e9' }), ctx())
    assert.deepEqual(r2.changes, [])
    const r3 = applyItemPatch({ bg_color: null }, item(), ctx())
    assert.deepEqual(r3.changes, [])
  })
})

describe('dimmed（v2-M1 F2）', () => {
  it('true 置灰并计入 changes', () => {
    const r = applyItemPatch({ dimmed: true }, item(), ctx())
    assert.deepEqual(r.errors, [])
    assert.equal(r.next.dimmed, true)
    assert.deepEqual(r.changes, [{ field: 'dimmed', old_value: undefined, new_value: true }])
  })
  it('false → 移除字段（点亮）', () => {
    const r = applyItemPatch({ dimmed: false }, item({ dimmed: true }), ctx())
    assert.deepEqual(r.errors, [])
    assert.ok(!('dimmed' in r.next))
    assert.deepEqual(r.changes, [{ field: 'dimmed', old_value: true, new_value: undefined }])
  })
  it('非 boolean 报错且拒绝写入', () => {
    const r = applyItemPatch({ dimmed: 'true' }, item(), ctx())
    assert.equal(r.errors.length, 1)
    assert.match(r.errors[0], /^dimmed 非法: 期望 boolean/)
    assert.equal(r.next, undefined)
  })
  it('重复置灰 / 未置灰时点亮点灯幂等（无 changes）', () => {
    assert.deepEqual(applyItemPatch({ dimmed: true }, item({ dimmed: true }), ctx()).changes, [])
    assert.deepEqual(applyItemPatch({ dimmed: false }, item(), ctx()).changes, [])
  })
})

describe('group_id（v2-M2 F3：自定义分组写入，严格分层）', () => {
  const GROUPS = [
    { id: 'grp-a', name: '测试阶段' },
    { id: 'grp-b', name: '发布阶段' },
  ]
  it('指向已有分组 → 写入并计入 changes；跨列重取目标列尾 order（列为空 → 0）', () => {
    const r = applyItemPatch({ group_id: 'grp-a' }, item(), ctx({ groups: GROUPS }))
    assert.deepEqual(r.errors, [])
    assert.equal(r.next.group_id, 'grp-a')
    assert.deepEqual(r.changes, [{ field: 'group_id', old_value: undefined, new_value: 'grp-a' }])
    assert.deepEqual(r.orderUpdate, { id: 's-01', order: 0 })
  })
  it('悬空分组 id → 400 拒绝（写入严格）', () => {
    const r = applyItemPatch({ group_id: 'grp-ghost' }, item(), ctx({ groups: GROUPS }))
    assert.equal(r.errors.length, 1)
    assert.match(r.errors[0], /^group_id 不存在: "grp-ghost"/)
    assert.equal(r.next, undefined)
  })
  it('ctx 缺省 groups 时只校验格式不校验存在性（change-set 预校验分层，同负责人姓名）', () => {
    const r = applyItemPatch({ group_id: 'grp-ghost' }, item(), ctx())
    assert.deepEqual(r.errors, [])
    assert.equal(r.next.group_id, 'grp-ghost')
  })
  it('null / 空串 / undefined → 移除字段（归「未分组」虚拟列）', () => {
    const withGroup = item({ group_id: 'grp-a' })
    for (const v of [null, '', '   ']) {
      const r = applyItemPatch({ group_id: v }, withGroup, ctx({ groups: GROUPS }))
      assert.deepEqual(r.errors, [])
      assert.ok(!('group_id' in r.next))
      assert.deepEqual(r.changes, [{ field: 'group_id', old_value: 'grp-a', new_value: undefined }])
    }
    // 未分组卡再归未分组 = 幂等无 changes
    assert.deepEqual(applyItemPatch({ group_id: null }, item(), ctx({ groups: GROUPS })).changes, [])
  })
})
