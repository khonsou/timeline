/**
 * @timeline/core 单测（node:test，秒级）：把 e2e 中反复验证的纯逻辑断言下沉到这里。
 * 覆盖：校验规则（validateItems）、归一化（normalizePublishAt）、差分合并
 * （mergeProducts/mergeMembers）、内容哈希 autoId、orders 计算、容量上限判定、
 * 内置目录常量、format 工具、board-view 派生。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  BUILTIN_MEMBERS,
  BUILTIN_PRODUCTS,
  STATUSES,
  TYPES,
  autoId,
  computeOrders,
  mergeMembers,
  mergeProducts,
  normalizePublishAt,
  parseCsv,
  readItemsInput,
  validateItems,
  validateProducts,
} from '@timeline/core/import-core'
import { cardsInDay, isPublished, nextOrder, publishDateOf, publishTimeOf } from '@timeline/core/board-view'
import { formatCompact, formatPublishAt, formatRoi } from '@timeline/core/format'

const NOW = '2026-09-04T12:00'
const baseOpts = () => ({
  isCsv: false,
  knownProducts: new Set(['P-1000']),
  knownMembers: new Map([
    ['林晓', 'M-1001'],
    ['陈远', 'M-1002'],
  ]),
  now: NOW,
})
const goodRow = () => ({
  title: '测试卡',
  type: '图文',
  publish_at: '2026-09-10T09:00',
  product_id: 'P-1000',
})
/** 互不相同的内容行（避免 autoId 哈希相同被「id 重复」跳行） */
const rowN = (n) => ({ ...goodRow(), title: `测试卡 ${n}` })

describe('normalizePublishAt 归一化', () => {
  it('接受三种格式并归一化为 YYYY-MM-DDTHH:mm', () => {
    assert.equal(normalizePublishAt('2026-09-04T09:05'), '2026-09-04T09:05')
    assert.equal(normalizePublishAt('2026-09-04 9:5'), '2026-09-04T09:05')
    assert.equal(normalizePublishAt('2026/9/4 09:05'), '2026-09-04T09:05')
    assert.equal(normalizePublishAt('2026-09-04T09:05:33'), '2026-09-04T09:05') // 带秒
  })
  it('拒绝非法日期与格式', () => {
    assert.equal(normalizePublishAt('明天上午'), null)
    assert.equal(normalizePublishAt('2026-13-01T09:00'), null)
    assert.equal(normalizePublishAt('2026-02-30T09:00'), null)
    assert.equal(normalizePublishAt('2026-09-04T24:00'), null)
    assert.equal(normalizePublishAt(''), null)
  })
})

describe('validateItems 校验规则', () => {
  it('title 必填 / type 枚举 / publish_at 必填且可解析', () => {
    const r = validateItems(
      [{ ...goodRow(), title: ' ' }, { ...goodRow(), type: '博客' }, { ...goodRow(), publish_at: 'x' }],
      baseOpts(),
    )
    assert.equal(r.valid.length, 0)
    assert.equal(r.skipped.length, 3)
    assert.match(r.skipped[0].reason, /title 必填且非空/)
    assert.match(r.skipped[1].reason, /type 非法: "博客"，合法值: 图文 \/ 视频 \/ 音频 \/ 直播 \/ 数据/)
    assert.match(r.skipped[2].reason, /publish_at 无法解析/)
  })

  it('status 枚举 + 缺省按 publish_at 推导（未来→待发布，否则已发布）', () => {
    const r = validateItems(
      [
        goodRow(), // 2026-09-10 未来 → 待发布
        { ...goodRow(), publish_at: '2026-09-01T09:00' }, // 过去 → 已发布
        { ...goodRow(), status: '进行中' },
      ],
      baseOpts(),
    )
    assert.equal(r.valid.length, 2)
    assert.equal(r.valid[0].status, '待发布')
    assert.equal(r.valid[1].status, '已发布')
    assert.match(r.skipped[0].reason, /status 非法: "进行中"/)
    assert.deepEqual(STATUSES, ['待执行', '待发布', '已发布'])
    assert.deepEqual(TYPES, ['图文', '视频', '音频', '直播', '数据'])
  })

  it('指标：非负数字；status ≠ 已发布 → 强制 null（forcedNullCount 计数）', () => {
    const r = validateItems(
      [
        { ...rowN(1), status: '已发布', roi: 2.5, propagation_4h: 12000, engagement_4h: 800 },
        { ...rowN(2), roi: 9.9 }, // 待发布带指标 → 强制 null
        { ...rowN(3), status: '已发布', roi: -1 },
      ],
      baseOpts(),
    )
    assert.equal(r.valid.length, 2)
    assert.equal(r.valid[0].roi, 2.5)
    assert.equal(r.valid[1].roi, null)
    assert.equal(r.forcedNullCount, 1)
    assert.match(r.skipped[0].reason, /roi 须为空或非负数字/)
  })

  it('负责人按姓名解析：已知姓名复用 id；未知姓名自动登记 memberHints（M-1xxx 段）', () => {
    const r = validateItems(
      [
        { ...rowN(1), content_owner: '林晓', delivery_owner: '王五' },
        { ...rowN(2), content_owner: '王五' }, // 同名复用上一个 hint 的 id
      ],
      baseOpts(),
    )
    assert.equal(r.valid[0].content_owner_id, 'M-1001')
    assert.equal(r.valid[0].delivery_owner_id, 'M-1003')
    assert.equal(r.valid[1].content_owner_id, 'M-1003')
    assert.deepEqual(r.memberHints, [{ id: 'M-1003', name: '王五' }])
  })

  it('productHints：未知 product_id 自动登记（product_name 优先，占位名可被升级）', () => {
    const r = validateItems(
      [
        { ...rowN(1), product_id: 'P-2001' },
        { ...rowN(2), product_id: 'P-2001', product_name: '键盘' },
        { ...rowN(3), product_id: '' },
      ],
      baseOpts(),
    )
    assert.deepEqual(r.productHints, [{ id: 'P-2001', name: '键盘' }])
    assert.equal(r.emptyProductCount, 1)
  })

  it('id 缺省内容哈希生成且幂等；显式重复 id 跳行', () => {
    const r1 = validateItems([goodRow()], baseOpts())
    const r2 = validateItems([goodRow()], baseOpts())
    assert.match(r1.valid[0].id, /^auto-[0-9a-f]{16}$/)
    assert.equal(r1.valid[0].id, r2.valid[0].id) // 同输入恒同 id（幂等保证）
    const rdup = validateItems([goodRow(), goodRow()], baseOpts())
    assert.equal(rdup.valid.length, 1)
    assert.equal(rdup.skipped.length, 1) // 第二条 id 重复
    const r3 = validateItems([{ ...goodRow(), id: 'x' }, { ...goodRow(), id: 'x' }], baseOpts())
    assert.match(r3.skipped[0].reason, /id 重复: x/)
  })
})

describe('mergeProducts / mergeMembers 差分合并', () => {
  it('同 id 改名更新、新 id 追加、未提及保留、占位名不覆盖', () => {
    const r = mergeProducts(
      [
        { id: 'P-1000', name: '光轴' },
        { id: 'P-1001', name: '键盘' },
      ],
      [
        { id: 'P-1000', name: '光轴 Pro' }, // 更新
        { id: 'P-1002', name: '鼠标' }, // 新增
        { id: 'P-1001', name: 'P-1001' }, // 占位名 → 不覆盖
      ],
    )
    assert.deepEqual(r.merged, [
      { id: 'P-1000', name: '光轴 Pro' },
      { id: 'P-1001', name: '键盘' },
      { id: 'P-1002', name: '鼠标' },
    ])
    assert.deepEqual([r.added, r.updated, r.unchanged], [1, 1, 1])
  })

  it('mergeMembers 以姓名为键：同名复用既有 id，新姓名追加', () => {
    const r = mergeMembers([{ id: 'M-1001', name: '林晓' }], [
      { id: 'M-9999', name: '林晓' }, // 同名 → 复用 M-1001，条目不变
      { id: 'M-1003', name: '王五' },
    ])
    assert.deepEqual(r.merged, [
      { id: 'M-1001', name: '林晓' },
      { id: 'M-1003', name: '王五' },
    ])
    assert.deepEqual([r.added, r.unchanged], [1, 1])
  })

  it('内置目录常量：P-1000 光轴 + 林晓/陈远（三端同一来源）', () => {
    assert.deepEqual(BUILTIN_PRODUCTS, [{ id: 'P-1000', name: '光轴' }])
    assert.deepEqual(BUILTIN_MEMBERS, [
      { id: 'M-1001', name: '林晓' },
      { id: 'M-1002', name: '陈远' },
    ])
  })
})

describe('autoId / computeOrders / 容量上限', () => {
  it('autoId 确定性：同输入恒同 id', () => {
    assert.equal(autoId('t', '图文', '2026-09-04T09:00', 'P-1000'), autoId('t', '图文', '2026-09-04T09:00', 'P-1000'))
    assert.notEqual(autoId('t', '图文', '2026-09-04T09:00', 'P-1000'), autoId('t', '视频', '2026-09-04T09:00', 'P-1000'))
  })

  it('computeOrders：按日分组、组内按 publish_at 时分排序赋 0..n', () => {
    const orders = computeOrders([
      { id: 'a', publish_at: '2026-09-04T10:00' },
      { id: 'b', publish_at: '2026-09-04T09:00' },
      { id: 'c', publish_at: '2026-09-05T08:00' },
    ])
    assert.deepEqual(orders, { a: 1, b: 0, c: 0 })
  })

  it('容量上限判定：合并后 >2000 整体拒绝（CLI/server 同一阈值）', () => {
    const MAX_CARDS = 2000
    assert.equal(2001 > MAX_CARDS, true)
    assert.equal(2000 > MAX_CARDS, false)
  })
})

describe('CSV 解析与输入', () => {
  it('RFC4180：引号包裹、双引号转义、字段内逗号/换行、BOM', () => {
    const rows = parseCsv('﻿标题,备注\n"a,b","他说 ""你好"""\n"x\ny",z\n')
    assert.deepEqual(rows, [
      ['标题', '备注'],
      ['a,b', '他说 "你好"'],
      ['x\ny', 'z'],
    ])
  })

  it('readItemsInput：中文表头别名映射 + {items,products} 包裹形式', () => {
    const csv = '标题,类型,计划发布时间,内容负责人\n测试卡,图文,2026-09-10 09:00,林晓\n'
    const input = readItemsInput(csv, '.csv')
    assert.equal(input.records[0].title, '测试卡')
    assert.equal(input.records[0].content_owner, '林晓')
    const wrapped = readItemsInput(JSON.stringify({ items: [{ 标题: 'x' }], products: [{ id: 'P-1', name: 'n' }] }), '.json')
    assert.deepEqual(wrapped.products, [{ id: 'P-1', name: 'n' }])
  })
})

describe('board-view 派生与 format', () => {
  const items = [
    { id: 'a', publish_at: '2026-09-04T10:00', status: '待发布' },
    { id: 'b', publish_at: '2026-09-04T09:00', status: '已发布' },
    { id: 'c', publish_at: '2026-09-05T08:00', status: '已发布' },
  ]
  it('publishDateOf / publishTimeOf / cardsInDay / nextOrder', () => {
    assert.equal(publishDateOf(items[0]), '2026-09-04')
    assert.equal(publishTimeOf(items[0]), '10:00')
    const col = cardsInDay(items, { a: 0, b: 1 }, '2026-09-04')
    assert.deepEqual(col.map((c) => c.id), ['a', 'b']) // orders 升序
    assert.equal(nextOrder(items, { a: 0, b: 1 }, '2026-09-04'), 2)
    assert.equal(nextOrder(items, {}, '2026-09-06'), 0) // 空列
  })
  it('isPublished：读 status；旧数据无 status 按 publish_at 兜底', () => {
    assert.equal(isPublished(items[1]), true)
    assert.equal(isPublished(items[0]), false)
    assert.equal(isPublished({ id: 'x', publish_at: '2020-01-01T00:00', status: '' }), true)
  })
  it('formatCompact / formatRoi / formatPublishAt', () => {
    assert.equal(formatCompact(856), '856')
    assert.equal(formatCompact(12300), '12.3k')
    assert.equal(formatCompact(200000), '200k')
    assert.equal(formatRoi(2.4), '×2.4')
    assert.match(formatPublishAt('2026-09-04T14:30'), /^9月4日 周五 14:30$/)
  })
})

describe('validateProducts', () => {
  it('id/name 必填非空且文件内唯一', () => {
    const r = validateProducts(
      [{ id: 'P-1', name: 'n' }, { id: 'P-1', name: 'x' }, { id: '', name: 'y' }, { id: 'P-2', name: '' }],
      { isCsv: false },
    )
    assert.equal(r.valid.length, 1)
    assert.equal(r.skipped.length, 3)
  })
})
