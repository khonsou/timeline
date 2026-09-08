/**
 * @timeline/core relation-core 单测（node:test）：v2-M3 F4 卡片关系纯函数验证。
 * 覆盖：normalizePreIds 格式/去重、validatePreIdRefs 自环/存在性分层、
 * diffPostMirror + applyMirrorUpdates 镜像不变量（A.post_ids ∋ B ⇔ B.pre_ids ∋ A）、
 * withPreIds / withAddedRelation / withRemovedRelation / cascadeDeleteRelations、
 * normalizeRelationFields 读取兜底（悬空剔除 + 镜像重建 + 引用稳定）、
 * relationEdges / layoutGraph（longest-path 分层、层内 orders 排序、遇环断边降级）。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  applyMirrorUpdates,
  cascadeDeleteRelations,
  diffPostMirror,
  layoutGraph,
  normalizePreIds,
  normalizeRelationFields,
  relationEdges,
  validatePreIdRefs,
  withAddedRelation,
  withPreIds,
  withRemovedRelation,
} from '@timeline/core/relation-core'

/** 极简卡（over 可覆盖任意字段） */
const item = (id, over = {}) => ({
  id,
  title: id,
  type: '图文',
  status: '待发布',
  publish_at: '2026-09-10T09:00',
  product_id: 'P-1000',
  content_owner_id: '',
  delivery_owner_id: '',
  roi: null,
  propagation_4h: null,
  engagement_4h: null,
  comment: '',
  ...over,
})

/** 镜像不变量：对每张卡断言 A.post_ids ∋ B ⇔ B.pre_ids ∋ A */
function assertMirrorInvariant(items) {
  for (const a of items) {
    for (const b of items) {
      assert.equal(
        (a.post_ids ?? []).includes(b.id),
        (b.pre_ids ?? []).includes(a.id),
        `镜像不变量破坏: ${a.id}.post_ids ∋ ${b.id} ⇎ ${b.id}.pre_ids ∋ ${a.id}`,
      )
    }
  }
}

describe('normalizePreIds / validatePreIdRefs', () => {
  it('格式校验：非数组 / 非字符串元素 / 空串元素被拒绝', () => {
    assert.match(normalizePreIds('x').error, /pre_ids 非法/)
    assert.match(normalizePreIds([1]).error, /pre_ids 元素非法/)
    assert.match(normalizePreIds(['  ']).error, /pre_ids 元素非法/)
  })
  it('重复 id 去重保序；空数组合法', () => {
    assert.deepEqual(normalizePreIds(['b', 'a', 'b']).value, ['b', 'a'])
    assert.deepEqual(normalizePreIds([]).value, [])
  })
  it('自环拒绝；strictIds 提供时校验存在性', () => {
    assert.match(validatePreIdRefs(['a'], 'a')[0], /不允许自环/)
    assert.deepEqual(validatePreIdRefs(['a'], 'b'), [])
    assert.match(validatePreIdRefs(['ghost'], 'b', new Set(['a']))[0], /指向不存在的卡片/)
  })
})

describe('diffPostMirror / applyMirrorUpdates', () => {
  it('新增前序 → 目标卡 post_ids 尾部追加；移除前序 → 剔除；空 → 移除字段', () => {
    const items = [item('a'), item('b'), item('c')]
    const add = diffPostMirror(items, 'c', [], ['a', 'b'])
    assert.deepEqual(add, [
      { id: 'a', old_post_ids: undefined, new_post_ids: ['c'] },
      { id: 'b', old_post_ids: undefined, new_post_ids: ['c'] },
    ])
    const applied = applyMirrorUpdates(items, add)
    assert.deepEqual(applied[0].post_ids, ['c'])
    assert.deepEqual(applied[2].post_ids, undefined)
    const rm = diffPostMirror(applied, 'c', ['a', 'b'], ['b'])
    assert.deepEqual(rm, [{ id: 'a', old_post_ids: ['c'], new_post_ids: undefined }])
    const after = applyMirrorUpdates(applied, rm)
    assert.ok(!('post_ids' in after[0]))
    assert.deepEqual(after[1].post_ids, ['c'])
  })
  it('幂等：已存在的镜像不重复追加；未变化的卡片保留原引用', () => {
    const items = [item('a', { post_ids: ['c'] }), item('c', { pre_ids: ['a'] })]
    assert.deepEqual(diffPostMirror(items, 'c', ['a'], ['a']), [])
    const same = applyMirrorUpdates(items, [])
    assert.equal(same, items)
  })
})

describe('withPreIds / withAddedRelation / withRemovedRelation / cascadeDeleteRelations', () => {
  it('withPreIds 同步两侧镜像，不变量成立', () => {
    let items = [item('a'), item('b'), item('c')]
    items = withPreIds(items, 'c', ['a', 'b'])
    assertMirrorInvariant(items)
    items = withPreIds(items, 'c', ['b'])
    assertMirrorInvariant(items)
    assert.deepEqual(items.find((x) => x.id === 'a').post_ids, undefined)
  })
  it('建边/删边幂等；自环与不存在卡片为 no-op', () => {
    let items = [item('a'), item('b')]
    items = withAddedRelation(items, 'a', 'b')
    assertMirrorInvariant(items)
    assert.equal(withAddedRelation(items, 'a', 'b'), items) // 已存在 → 原样
    assert.equal(withAddedRelation(items, 'a', 'a'), items) // 自环 → 原样
    assert.equal(withAddedRelation(items, 'ghost', 'b'), items)
    const removed = withRemovedRelation(items, 'a', 'b')
    assertMirrorInvariant(removed)
    assert.equal(withRemovedRelation(items, 'b', 'a'), items) // 反向边不存在 → 原样
  })
  it('删卡级联：从所有相关卡的 pre_ids / post_ids 剔除', () => {
    let items = [item('a'), item('b'), item('c'), item('d')]
    items = withPreIds(items, 'c', ['a', 'b'])
    items = withPreIds(items, 'd', ['c'])
    const cascaded = cascadeDeleteRelations(items, new Set(['c']))
    assert.deepEqual(cascaded.find((x) => x.id === 'a').post_ids, undefined)
    assert.deepEqual(cascaded.find((x) => x.id === 'b').post_ids, undefined)
    assert.deepEqual(cascaded.find((x) => x.id === 'd').pre_ids, undefined)
    assertMirrorInvariant(cascaded.filter((x) => x.id !== 'c'))
  })
})

describe('normalizeRelationFields（读取兜底）', () => {
  it('悬空 id / 自环 / 重复剔除；post_ids 按 pre_ids 全量重建', () => {
    const items = [
      item('a', { pre_ids: ['ghost', 'a', 'b', 'b'], post_ids: ['stale'] }),
      item('b', { post_ids: ['ghost2'] }),
      item('c'),
    ]
    const out = normalizeRelationFields(items)
    assert.deepEqual(out.find((x) => x.id === 'a').pre_ids, ['b'])
    assert.deepEqual(out.find((x) => x.id === 'a').post_ids, undefined)
    assert.deepEqual(out.find((x) => x.id === 'b').post_ids, ['a'])
    assertMirrorInvariant(out)
  })
  it('引用稳定：一致数据返回原数组原对象（渲染 memo 友好）', () => {
    const items = [item('a', { post_ids: ['b'] }), item('b', { pre_ids: ['a'] })]
    const out = normalizeRelationFields(items)
    assert.equal(out[0], items[0])
    assert.equal(out[1], items[1])
  })
})

describe('relationEdges / layoutGraph', () => {
  it('边集从 pre_ids 派生；两端悬空/自环/重复边剔除', () => {
    const items = [
      item('a', { post_ids: ['b'] }),
      item('b', { pre_ids: ['a', 'a', 'ghost'] }),
      item('c', { pre_ids: ['b'] }),
    ]
    const edges = relationEdges(items)
    assert.deepEqual(
      edges.map((e) => `${e.from}→${e.to}`),
      ['a→b', 'b→c'],
    )
    assert.ok(edges.every((e) => !e.broken))
  })
  it('longest-path 分层：链式 a→b→c 三层；层内按 orders 排序', () => {
    const items = [
      item('a', { post_ids: ['b'] }),
      item('b', { pre_ids: ['a'], post_ids: ['c'] }),
      item('c', { pre_ids: ['b'] }),
      item('d', { pre_ids: ['a'] }),
      item('e'), // 无关系 → 不进图
    ]
    const orders = { a: 0, b: 1, c: 2, d: -1, e: 9 }
    const g = layoutGraph(items, orders)
    const layerOf = (id) => g.nodes.find((n) => n.id === id).layer
    assert.equal(layerOf('a'), 0)
    assert.equal(layerOf('b'), 1)
    assert.equal(layerOf('c'), 2)
    assert.equal(layerOf('d'), 1) // d 与 b 同层
    // 同层（layer 1）内 orders：d(-1) 在 b(1) 前
    const l1 = g.nodes.filter((n) => n.layer === 1).sort((x, y) => x.index - y.index)
    assert.deepEqual(l1.map((n) => n.id), ['d', 'b'])
    assert.equal(g.maxLayer, 2)
    assert.ok(!g.nodes.some((n) => n.id === 'e'))
  })
  it('多对多：汇聚 a→c, b→c 时 c 的层 = max(a,b)+1', () => {
    const items = [
      item('a', { post_ids: ['c'] }),
      item('b', { pre_ids: ['a'], post_ids: ['c'] }),
      item('c', { pre_ids: ['a', 'b'] }),
    ]
    const g = layoutGraph(items, { a: 0, b: 1, c: 2 })
    const layerOf = (id) => g.nodes.find((n) => n.id === id).layer
    assert.equal(layerOf('b'), 1)
    assert.equal(layerOf('c'), 2) // 最长链 a→b→c
  })
  it('遇环降级：断「目标入度最小」边标 broken，分层不死循环、输出 DAG', () => {
    // a→b→c→a 三环：各节点入度均 1 → 断先遇到者；另有 d→c 提高 c 入度时断他处
    const items = [
      item('a', { pre_ids: ['c'], post_ids: ['b'] }),
      item('b', { pre_ids: ['a'], post_ids: ['c'] }),
      item('c', { pre_ids: ['b'], post_ids: ['a'] }),
    ]
    const g = layoutGraph(items, { a: 0, b: 1, c: 2 })
    assert.equal(g.edges.filter((e) => e.broken).length, 1)
    assert.equal(g.nodes.length, 3)
    // 断边后分层可完成（不死循环），层号互不相同形成链
    const layers = g.nodes.map((n) => n.layer).sort()
    assert.deepEqual(layers, [0, 1, 2])
    // 自环边在 relationEdges 已被剔除（布局层双保险）
    const self = layoutGraph([item('a', { pre_ids: ['a'] })], {})
    assert.equal(self.edges.length, 0)
    assert.equal(self.nodes.length, 1) // 有（被剔的）关系字段 → 仍算 networked 节点
    assert.equal(self.nodes[0].layer, 0)
  })
  it('空图：无关系卡 → 空布局', () => {
    const g = layoutGraph([item('a'), item('b')], {})
    assert.deepEqual(g.nodes, [])
    assert.deepEqual(g.edges, [])
    assert.equal(g.maxLayer, -1)
  })
})
