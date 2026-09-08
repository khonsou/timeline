/**
 * @timeline/core group-core 单测（node:test）：v2-M2 F3 统一分组模型核心规则。
 * 覆盖：group_create 确定性 id、存量迁移（今天±30 = 61 日期组 / 窗口内回填 /
 * 窗口外归未分组 / 幂等确定性）、写入时归属解析（同名日期组挂入 / 无同名组
 * 未分组 / 非日期组名不解析）。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  MIGRATE_WINDOW_RADIUS,
  isDateGroupName,
  migrateGroupId,
  migrateLegacyGroups,
  newChangeSetGroupId,
  resolveWriteTimeGroup,
} from '@timeline/core/group-core'
import { MAX_GROUPS } from '@timeline/core/types'

const item = (over = {}) => ({
  id: 's-01',
  title: '示例卡',
  type: '图文',
  status: '已发布',
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

const TODAY = '2026-09-10'

describe('newChangeSetGroupId / migrateGroupId 确定性', () => {
  it('同输入同 id；不同 op 序号 / client_ref 不撞', () => {
    assert.equal(newChangeSetGroupId('测试', 'g1', 0), newChangeSetGroupId('测试', 'g1', 0))
    assert.notEqual(newChangeSetGroupId('测试', 'g1', 0), newChangeSetGroupId('测试', 'g1', 1))
    assert.notEqual(newChangeSetGroupId('测试', null, 0), newChangeSetGroupId('测试', 'g1', 0))
    assert.match(newChangeSetGroupId('测试', null, 0), /^grp-[0-9a-f]{16}$/)
    assert.equal(migrateGroupId('2026-09-10'), migrateGroupId('2026-09-10'))
    assert.match(migrateGroupId('2026-09-10'), /^grp-[0-9a-f]{12}$/)
  })
})

describe('migrateLegacyGroups 存量迁移（加载时自动、一次性、幂等）', () => {
  it('恒派生今天±30 共 61 个日期组（含空日期列，所见与 v1 首屏一致）', () => {
    const { groups } = migrateLegacyGroups([], TODAY)
    assert.equal(groups.length, MAX_GROUPS)
    assert.equal(groups[0].name, '2026-08-11')
    assert.equal(groups[60].name, '2026-10-10')
    assert.equal(groups[MIGRATE_WINDOW_RADIUS].name, TODAY)
    // 组名全是 YYYY-MM-DD；id 确定性
    assert.ok(groups.every((g) => isDateGroupName(g.name)))
    assert.equal(groups[MIGRATE_WINDOW_RADIUS].id, migrateGroupId(TODAY))
  })
  it('窗口内卡片按 publish_at 回填 group_id；窗口外卡片不分配（归未分组）', () => {
    const items = [
      item({ id: 'in-1', publish_at: '2026-09-10T09:00' }),
      item({ id: 'in-2', publish_at: '2026-08-11T23:59' }), // 窗口首日
      item({ id: 'in-3', publish_at: '2026-10-10T00:00' }), // 窗口末日
      item({ id: 'out-1', publish_at: '2026-06-10T09:00' }), // 窗口外历史
      item({ id: 'out-2', publish_at: '2026-12-01T09:00' }), // 窗口外未来
    ]
    const { groups, assignments } = migrateLegacyGroups(items, TODAY)
    assert.equal(assignments['in-1'], migrateGroupId('2026-09-10'))
    assert.equal(assignments['in-2'], migrateGroupId('2026-08-11'))
    assert.equal(assignments['in-3'], migrateGroupId('2026-10-10'))
    assert.ok(!('out-1' in assignments))
    assert.ok(!('out-2' in assignments))
    assert.equal(groups.length, 61)
  })
  it('幂等：同 today 重跑得到同一份 groups 与 assignments', () => {
    const items = [item({ id: 'a', publish_at: '2026-09-09T08:00' })]
    const r1 = migrateLegacyGroups(items, TODAY)
    const r2 = migrateLegacyGroups(items, TODAY)
    assert.deepEqual(r1, r2)
  })
})

describe('resolveWriteTimeGroup 写入时归属解析（一次性）', () => {
  const GROUPS = [
    { id: 'g-0912', name: '2026-09-12' },
    { id: 'g-x', name: '测试阶段' },
  ]
  it('组名 == publish_at 日期 → 返回该组 id', () => {
    assert.equal(resolveWriteTimeGroup(GROUPS, '2026-09-12T09:00'), 'g-0912')
  })
  it('无同名日期组 / 非日期组名不匹配 → undefined（不自动建组）', () => {
    assert.equal(resolveWriteTimeGroup(GROUPS, '2026-09-13T09:00'), undefined)
    assert.equal(resolveWriteTimeGroup(GROUPS, '测试阶段T09:00'), undefined)
    assert.equal(resolveWriteTimeGroup([], '2026-09-12T09:00'), undefined)
  })
})

describe('isDateGroupName', () => {
  it('YYYY-MM-DD 才算日期组名', () => {
    assert.ok(isDateGroupName('2026-09-10'))
    assert.ok(!isDateGroupName('2026-9-1'))
    assert.ok(!isDateGroupName('测试阶段'))
    assert.ok(!isDateGroupName(''))
  })
})
