/**
 * Agent PATCH 规则（纯函数，core 唯一定义，三端复用）
 *
 * 由 packages/server 的 PATCH /api/items/:id 校验/合并逻辑下沉而来，
 * 语义与原 server 内联实现逐字一致（2026-09 迁移）。覆盖：
 * 字段白名单、逐字段校验（错误文案、收集顺序、拼接方式）、负责人解析与登记、
 * 指标-状态联动（gate）、变更检测与跨日 orders 更新。
 *
 * 引用方式：
 * - server / CLI（Node 22+ strip-types 直引 .ts）：
 *     import { applyItemPatch } from '@timeline/core/patch-core'
 *     或 import { applyItemPatch } from '@timeline/core/lib/patch-core.ts'
 * - web（Vite monorepo alias，若将来需要）：import ... from '@timeline/core/patch-core'
 *
 * 本文件保持纯 TypeScript（含 erasable 类型标注），不依赖 DOM / Node API，
 * 不改写传入的 item / members / orders，也不做审计序列化（审计属 server 职责）。
 */
import type { ContentItem, Member } from '../types/content'
import type { Orders } from './board-view.ts'
import { nextOrder } from './board-view.ts'
import { STATUSES, TYPES, normalizeMetric, normalizePublishAt } from './import-core.ts'

/** PATCH 允许修改的字段白名单 */
export const PATCH_FIELDS = [
  'title',
  'type',
  'status',
  'publish_at',
  'product_id',
  'content_owner_id',
  'delivery_owner_id',
  'roi',
  'propagation_4h',
  'engagement_4h',
  'comment',
] as const
export type PatchField = (typeof PATCH_FIELDS)[number]

/** 三项效果指标字段（PATCH 指标-状态联动的作用对象） */
export const METRIC_FIELDS = ['roi', 'propagation_4h', 'engagement_4h'] as const
export type MetricField = (typeof METRIC_FIELDS)[number]

/** 新成员 id：扫现有 id 数字后缀取 max（基准 1000），M-<max+1 四位补齐> */
export function nextMemberId(members: Member[]): string {
  let max = 1000
  for (const m of members) {
    const match = String(m.id).match(/(\d+)$/)
    if (match) max = Math.max(max, Number(match[1]))
  }
  return `M-${String(max + 1).padStart(4, '0')}`
}

export interface ResolveOwnerResult {
  /** 解析后的负责人 id：空输入 → ''；按 id 命中 → 原 id；按姓名命中 → 复用该成员 id；未知名 → 新登记 id */
  id: string
  /** 未知名新登记时返回该成员对象（调用方负责并入目录）；命中或空输入时为 undefined */
  registered?: Member
}

/**
 * 负责人 PATCH 解析：空 → ''；按 id 命中 → 原样；按姓名命中 → 复用 id；
 * 未知名 → 分配新 id 并返回待登记成员。pending 参与命中与 id 分配，同一 PATCH 内去重。
 */
export function resolveOwnerPatch(raw: unknown, members: Member[], pending: Member[] = []): ResolveOwnerResult {
  const v = String(raw ?? '').trim()
  if (!v) return { id: '' }
  const all = [...members, ...pending]
  const byId = all.find((m) => m.id === v)
  if (byId) return { id: byId.id }
  const byName = all.find((m) => m.name === v)
  if (byName) return { id: byName.id }
  const registered: Member = { id: nextMemberId(all), name: v }
  return { id: registered.id, registered }
}

export interface ItemPatchChange {
  field: PatchField
  old_value: unknown
  new_value: unknown
}

export interface ItemPatchResult {
  /** 白名单之外的字段（含 id/orders 等只读字段）；非空时调用方应拒绝并停止写入 */
  unknownFields: string[]
  /** 逐字段校验错误（按字段顺序收集）；非空时调用方应拒绝并停止写入 */
  errors: string[]
  /** 合并后的条目（含 gate 结果）；未知字段/校验失败时为 undefined */
  next?: ContentItem
  /** 本 PATCH 新登记的成员（校验失败导致提前拒绝时保留已登记部分，与迁移前行为一致） */
  pendingMembers: Member[]
  /** 相对 item 实际变化的字段（含 gate 产生的变化） */
  changes: ItemPatchChange[]
  /** 跨日移动时的目标列 order；未跨日为 null */
  orderUpdate: { id: string; order: number } | null
}

/**
 * 对单条内容应用 PATCH 规则，纯函数：不改写传入的 item/members/orders。
 * 未知字段或校验失败时不产生 next/changes/orderUpdate。
 */
export function applyItemPatch(
  body: Record<string, unknown>,
  item: ContentItem,
  ctx: { members: Member[]; items: ContentItem[]; orders: Orders },
): ItemPatchResult {
  const next = { ...item }
  const errors: string[] = []
  const unknownFields = Object.keys(body).filter((k) => !(PATCH_FIELDS as readonly string[]).includes(k))
  const pendingMembers: Member[] = []

  if (unknownFields.length === 0) {
    if ('title' in body) {
      const v = String(body.title ?? '').trim()
      if (!v) errors.push('title 必填且非空')
      else next.title = v
    }
    if ('type' in body) {
      const v = String(body.type ?? '').trim()
      if (!(TYPES as readonly string[]).includes(v)) errors.push(`type 非法: "${v}"，合法值: ${TYPES.join(' / ')}`)
      else next.type = v as ContentItem['type']
    }
    if ('status' in body) {
      const v = String(body.status ?? '').trim()
      if (!(STATUSES as readonly string[]).includes(v)) errors.push(`status 非法: "${v}"，合法值: ${STATUSES.join(' / ')}`)
      else next.status = v as ContentItem['status']
    }
    if ('publish_at' in body) {
      const v = normalizePublishAt(body.publish_at)
      if (!v) {
        errors.push(
          `publish_at 无法解析: "${body.publish_at}"（接受 YYYY-MM-DDTHH:mm / YYYY-MM-DD HH:mm / YYYY/M/D H:mm）`,
        )
      } else next.publish_at = v
    }
    // 未知 product_id 保留原样、不动目录（PATCH 不携带 product_name，不触发登记）
    if ('product_id' in body) next.product_id = String(body.product_id ?? '').trim()
    if ('content_owner_id' in body) {
      const r = resolveOwnerPatch(body.content_owner_id, ctx.members, pendingMembers)
      next.content_owner_id = r.id
      if (r.registered) pendingMembers.push(r.registered)
    }
    if ('delivery_owner_id' in body) {
      const r = resolveOwnerPatch(body.delivery_owner_id, ctx.members, pendingMembers)
      next.delivery_owner_id = r.id
      if (r.registered) pendingMembers.push(r.registered)
    }
    for (const name of METRIC_FIELDS) {
      if (name in body) {
        const r = normalizeMetric(body[name], name)
        if (r.error) errors.push(r.error)
        else next[name] = r.value
      }
    }
    if ('comment' in body) next.comment = String(body.comment ?? '')
  }

  if (unknownFields.length > 0 || errors.length > 0) {
    return { unknownFields, errors, next: undefined, pendingMembers, changes: [], orderUpdate: null }
  }

  // 指标-状态联动：非「已发布」状态强制三项效果指标为 null
  if (next.status !== '已发布') {
    for (const name of METRIC_FIELDS) next[name] = null
  }

  const changes: ItemPatchChange[] = []
  for (const f of PATCH_FIELDS) {
    if (next[f] !== item[f]) changes.push({ field: f, old_value: item[f], new_value: next[f] })
  }

  let orderUpdate: { id: string; order: number } | null = null
  const newDate = String(next.publish_at ?? '').slice(0, 10)
  const oldDate = String(item.publish_at ?? '').slice(0, 10)
  if (newDate !== oldDate) {
    orderUpdate = { id: item.id, order: nextOrder(ctx.items, ctx.orders, newDate) }
  }

  return { unknownFields, errors, next, pendingMembers, changes, orderUpdate }
}
