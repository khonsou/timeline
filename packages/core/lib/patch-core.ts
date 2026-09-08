/**
 * Agent PATCH 规则（纯函数，core 唯一定义，三端复用）
 *
 * 由 packages/server 的 PATCH /api/boards/:id/items/:itemId 校验/合并逻辑下沉而来，
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
import type { ContentItem, Group, Member } from '../types/content'
import { normalizeBgColor } from '../types/content.ts'
import type { Orders } from './board-view.ts'
import { nextOrderInColumn } from './board-view.ts'
import { resolveWriteTimeGroup } from './group-core.ts'
import { diffPostMirror, normalizePreIds, validatePreIdRefs, type MirrorUpdate } from './relation-core.ts'
import { STATUSES, TYPES, normalizeLinks, normalizeMetric, normalizePublishAt } from './import-core.ts'

/** PATCH 允许修改的字段白名单（v19+ 追加 links；v2-M1 追加 bg_color / dimmed；v2-M2 追加 group_id；v2-M3 追加 pre_ids） */
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
  'links',
  'bg_color',
  'dimmed',
  'group_id',
  'pre_ids',
  // v2-M3 F4 单一写入源铁律：post_ids 是 core 镜像（外部只读），不在白名单内——
  // 直接 patch post_ids 走 unknownFields → 400「不支持修改的字段」
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
  /** 跨列移动（显式 group_id / publish_at 归属解析）时的目标列列尾 order；未跨列为 null */
  orderUpdate: { id: string; order: number } | null
  /** v2-M3 F4：pre_ids 变更引起的其它卡 post_ids 镜像差分（同一事务内由调用方应用） */
  mirrorUpdates: MirrorUpdate[]
}

/**
 * 对单条内容应用 PATCH 规则，纯函数：不改写传入的 item/members/orders。
 * 未知字段或校验失败时不产生 next/changes/orderUpdate。
 *
 * ctx.groups（v2-M2 F3）：传入时启用 group_id 存在性校验（写入严格：指向不存在的
 * 分组 → 拒绝）；缺省（如 change-set 创建时无看板上下文的预校验）只校验格式，
 * 存在性留待 commit 全量校验（与负责人姓名解析同一分层）。
 */
export function applyItemPatch(
  body: Record<string, unknown>,
  item: ContentItem,
  ctx: { members: Member[]; items: ContentItem[]; orders: Orders; groups?: Group[] },
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
    // links：结构化链接（协议 §8）；null / 空串 → 清空（空数组）
    if ('links' in body) {
      const r = normalizeLinks(body.links)
      if (r.error) errors.push(r.error)
      else next.links = r.value
    }
    // bg_color（v2-M1b F1）：卡片自有 hex 属性——#rgb/#rrggbb 归一化为小写 #rrggbb；
    // 旧色板 token 归一化为对应 hex（向后兼容）；null / 空串 / undefined → 移除字段（恢复默认）
    if ('bg_color' in body) {
      const raw = body.bg_color
      if (raw === null || raw === undefined || String(raw).trim() === '') {
        delete next.bg_color
      } else {
        const v = normalizeBgColor(String(raw).trim())
        if (!v) {
          errors.push(`bg_color 非法: "${String(raw).trim()}"，合法值: #rgb / #rrggbb 十六进制色值`)
        } else next.bg_color = v
      }
    }
    // dimmed（v2-M1 F2）：严格 boolean；true → 置灰，false → 移除字段（点亮）
    if ('dimmed' in body) {
      const raw = body.dimmed
      if (typeof raw !== 'boolean') {
        errors.push(`dimmed 非法: 期望 boolean，实际 ${JSON.stringify(raw)}`)
      } else if (raw) {
        next.dimmed = true
      } else {
        delete next.dimmed
      }
    }
    // group_id（v2-M2 F3 统一分组模型）：显式值优先——null / 空串 / undefined → 移除字段
    // （归「未分组」虚拟列）；非空字符串 → ctx.groups 存在时校验存在性（写入严格 400），
    // 缺省只校验格式（change-set 预校验无看板上下文，存在性留待 commit——与负责人姓名解析同一分层）。
    // 未显式给 group_id 但改了 publish_at → 写入时归属解析（一次性）：挂入组名 == 新日期
    // 的组；无同名日期组 → 归未分组（移除字段，绝不自动建组）。ctx.groups 缺省时跳过解析。
    if ('group_id' in body) {
      const raw = body.group_id
      if (raw === null || raw === undefined || String(raw).trim() === '') {
        delete next.group_id
      } else {
        const v = String(raw).trim()
        if (ctx.groups && !ctx.groups.some((g) => g.id === v)) {
          errors.push(`group_id 不存在: "${v}"（须指向看板已有分组；同变更集内可先 group_create 再引用）`)
        } else next.group_id = v
      }
    } else if ('publish_at' in body && ctx.groups && next.publish_at.slice(0, 10) !== item.publish_at.slice(0, 10)) {
      // 仅在日期部分实际变化时解析（同值补丁不动分组归属）
      const gid = resolveWriteTimeGroup(ctx.groups, next.publish_at)
      if (gid) next.group_id = gid
      else delete next.group_id
    }
    // pre_ids（v2-M3 F4 卡片关系，唯一写入源）：数组格式校验 + 去重；自环拒绝；
    // ctx.groups 存在（有看板上下文）时逐个校验元素为板内存在卡片 id（写入严格 400，
    // 与 group_id 同一分层——change-set 预校验无上下文，存在性留待 commit）。
    // 空数组 = 清空全部前序（移除字段，保持 doc 干净）。post_ids 镜像在下方统一差分。
    if ('pre_ids' in body) {
      const n = normalizePreIds(body.pre_ids)
      if (n.error) {
        errors.push(n.error)
      } else {
        const v = n.value!
        const refErrs = validatePreIdRefs(v, item.id, ctx.groups ? new Set(ctx.items.map((x) => x.id)) : undefined)
        if (refErrs.length > 0) errors.push(...refErrs)
        else if (v.length > 0) next.pre_ids = v
        else delete next.pre_ids
      }
    }
  }

  if (unknownFields.length > 0 || errors.length > 0) {
    return { unknownFields, errors, next: undefined, pendingMembers, changes: [], orderUpdate: null, mirrorUpdates: [] }
  }

  // 指标-状态联动：非「已发布」状态强制三项效果指标为 null
  if (next.status !== '已发布') {
    for (const name of METRIC_FIELDS) next[name] = null
  }

  const changes: ItemPatchChange[] = []
  for (const f of PATCH_FIELDS) {
    // links / pre_ids 是数组，引用比较恒不等 → 按内容（JSON 序）比较，保证同值补丁幂等无审计
    const changed =
      f === 'links' || f === 'pre_ids'
        ? JSON.stringify(next[f] ?? null) !== JSON.stringify(item[f] ?? null)
        : next[f] !== item[f]
    if (changed) changes.push({ field: f, old_value: item[f], new_value: next[f] })
  }

  let orderUpdate: { id: string; order: number } | null = null
  // 列归属变化（显式 group_id / publish_at 归属解析）→ 重取目标列列尾 order（v1 改期语义的一般化）
  const newKey = next.group_id ?? ''
  const oldKey = item.group_id ?? ''
  if (newKey !== oldKey) {
    orderUpdate = { id: item.id, order: nextOrderInColumn(ctx.items, ctx.orders, newKey) }
  }

  // v2-M3 F4：pre_ids 实际变化 → 其它卡的 post_ids 镜像差分（同一事务内由调用方应用 + 审计）
  const preIdsChanged = JSON.stringify(next.pre_ids ?? null) !== JSON.stringify(item.pre_ids ?? null)
  const mirrorUpdates = preIdsChanged
    ? diffPostMirror(ctx.items, item.id, item.pre_ids ?? [], next.pre_ids ?? [])
    : []

  return { unknownFields, errors, next, pendingMembers, changes, orderUpdate, mirrorUpdates }
}
