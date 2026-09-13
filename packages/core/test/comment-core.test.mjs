/**
 * @timeline/core comment-core 单测（node:test）：匿名评论（v2-M4）三入口。
 * 覆盖：normalizeComments 写入口径（合法通过 / 非数组拒绝 / 缺字段拒绝 / author 空串允许）、
 * sanitizeComments 读取兜底（逐条剔除非法项）、mergeCommentsById 409 重放合并
 * （union by id / 同 id 远端为准 / created_at 升序）。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mergeCommentsById, normalizeComments, sanitizeComments } from '@timeline/core/comment-core'

const c = (over = {}) => ({
  id: 'c-1',
  author: '小李',
  body: '这个素材数据很好',
  created_at: '2026-09-10T09:00:00.000Z',
  ...over,
})

describe('normalizeComments（写入口径：PATCH / change-set）', () => {
  it('合法数组通过并归一化（id/author/created_at trim，body 保留原样）', () => {
    const r = normalizeComments([c(), c({ id: ' c-2 ', author: ' 大张 ', body: '  保留\n换行  ', created_at: '2026-09-10T10:00:00.000Z' })])
    assert.equal(r.error, undefined)
    assert.equal(r.value.length, 2)
    assert.equal(r.value[1].id, 'c-2')
    assert.equal(r.value[1].author, '大张')
    assert.equal(r.value[1].body, '  保留\n换行  ')
  })
  it('author 空字符串允许；author 缺省归一化为空串（未署名）', () => {
    const r = normalizeComments([c({ author: '' }), { id: 'c-2', body: '匿名', created_at: '2026-09-10T10:00:00.000Z' }])
    assert.equal(r.error, undefined)
    assert.equal(r.value[0].author, '')
    assert.equal(r.value[1].author, '')
  })
  it('null / undefined / 空串 → 空数组（清空语义，同 links）', () => {
    for (const v of [null, undefined, '', '   ']) {
      const r = normalizeComments(v)
      assert.equal(r.error, undefined)
      assert.deepEqual(r.value, [])
    }
  })
  it('非数组拒绝', () => {
    const r = normalizeComments('不是数组')
    assert.match(r.error, /^comments 须为数组/)
    const r2 = normalizeComments({ id: 'c-1' })
    assert.match(r2.error, /^comments 须为数组/)
  })
  it('缺 id / body / created_at 或非对象元素整体拒绝（带下标文案）', () => {
    assert.match(normalizeComments([c({ id: '' })]).error, /comments\[0\] 非法/)
    assert.match(normalizeComments([c(), c({ id: 'c-2', body: '  ' })]).error, /comments\[1\] 非法/)
    assert.match(normalizeComments([c({ created_at: 123 })]).error, /comments\[0\] 非法/)
    assert.match(normalizeComments(['x']).error, /comments\[0\] 须为对象/)
  })
  it('author 非字符串拒绝', () => {
    const r = normalizeComments([c({ author: 42 })])
    assert.match(r.error, /comments\[0\]\.author 须为字符串/)
  })
})

describe('sanitizeComments（读取兜底：web 加载 doc）', () => {
  it('非数组 / undefined → undefined（字段移除）', () => {
    assert.equal(sanitizeComments(undefined), undefined)
    assert.equal(sanitizeComments('x'), undefined)
    assert.equal(sanitizeComments(42), undefined)
  })
  it('逐条剔除非法项，合法项保留', () => {
    const r = sanitizeComments([c(), 'bad', { id: 'c-2' }, null])
    assert.equal(r.length, 1)
    assert.equal(r[0].id, 'c-1')
  })
  it('清洗后为空 → undefined', () => {
    assert.equal(sanitizeComments([]), undefined)
    assert.equal(sanitizeComments(['bad', 1]), undefined)
  })
})

describe('mergeCommentsById（409 重放：id 键控 union）', () => {
  it('双方独有的评论都保留，按 created_at 升序', () => {
    const base = [c({ id: 'c-b', created_at: '2026-09-10T09:05:00.000Z' })]
    const incoming = [c({ id: 'c-a', created_at: '2026-09-10T09:01:00.000Z' })]
    const r = mergeCommentsById(base, incoming)
    assert.deepEqual(r.map((x) => x.id), ['c-a', 'c-b'])
  })
  it('同 id 以 base（远端）为准', () => {
    const r = mergeCommentsById([c({ body: '远端版' })], [c({ body: '本地版' })])
    assert.equal(r.length, 1)
    assert.equal(r[0].body, '远端版')
  })
  it('一方为空 → 另一方原样；双方皆空 → undefined', () => {
    assert.deepEqual(mergeCommentsById(undefined, [c()])?.length, 1)
    assert.deepEqual(mergeCommentsById([c()], undefined)?.length, 1)
    assert.equal(mergeCommentsById(undefined, undefined), undefined)
    assert.equal(mergeCommentsById([], []), undefined)
  })
})
