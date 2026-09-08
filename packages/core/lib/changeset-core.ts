/**
 * Change Set（变更集）核心规则（纯函数，core 唯一定义，协议 §4.2 / §5.4–5.7 / §6）
 *
 * 覆盖两个入口：
 * - validateChangeSet(input)：创建变更集时的预校验（格式类错误尽早暴露）——
 *   operations 非空数组、op 仅 create/patch、patch 的 changes 与 create 的 item
 *   走与 patch-core 同一套白名单与逐字段校验（同文案）。负责人姓名解析不在此阶段
 *   发生（无目录上下文），留待 commit。
 * - applyChangeSet(boardDoc, operations, ctx)：在传入的 doc 快照上按序应用 create/patch，
 *   对应 commit 事务内「在当前快照上按序应用 operations + core 全量校验」一步：
 *   create 服务端分配确定性内容哈希 id（同一 change-set 内容重试 id 不变）；
 *   同一日期多张新卡按 ops 顺序 nextOrder 追加列尾、已有卡片顺序不动；
 *   patch 复用 applyItemPatch（指标 gate / 负责人登记 / 跨日 orders）；
 *   负责人在整个 change-set 内 pending 去重后一次性并入 members；
 *   2000 张硬上限与重复 id 检查；任何一步失败返回完整 errors（全批拒绝，不产生部分结果）。
 *
 * 本文件保持纯 TypeScript（含 erasable 类型标注），不依赖 DOM / Node API，
 * 不改写传入的 doc / operations，也不做审计序列化与版本写入（属 server 职责）。
 *
 * 引用方式：
 * - server / CLI（Node 22+ strip-types 直引 .ts）：
 *     import { validateChangeSet, applyChangeSet } from '@timeline/core/changeset-core'
 */
import { normalizeBgColor } from '../types/content.ts'
import { MAX_GROUPS } from '../types/content.ts'
import type {
  ChangeSetCreatedGroup,
  ChangeSetCreatedItem,
  ChangeSetOp,
  ContentItem,
  Group,
  Link,
  Member,
} from '../types/content'
import type { Orders } from './board-view.ts'
import { nextOrder, publishDateOf } from './board-view.ts'
import { newChangeSetGroupId, resolveWriteTimeGroup } from './group-core.ts'
import { PATCH_FIELDS, applyItemPatch, resolveOwnerPatch } from './patch-core.ts'
import { STATUSES, TYPES, normalizeLinks, normalizeMetric, normalizePublishAt, sha1Hex } from './import-core.ts'

/** 单板卡片数硬上限（协议 §9：change-set commit 时校验，超限全批拒绝） */
export const BOARD_ITEM_LIMIT = 2000

/** applyChangeSet 接受的看板快照（与 web board-doc / server doc 同形状，core 只依赖最小结构） */
export interface ChangeSetBoardDoc {
  items: ContentItem[]
  orders: Orders
  products: { id: string; name: string }[]
  members: Member[]
  /** v2-M2 F3 统一分组模型：分组集合（数组序 = 列顺序，≤ 61）；缺省 = 无分组（仅虚拟「未分组」列） */
  groups?: Group[]
  meta?: { name: string; created_at: string }
}

/** 逐字段变更记录（供审计；与 patch-core 的 ItemPatchChange 同形状 + item_id 维度） */
export interface ChangeSetFieldChange {
  item_id: string
  field: string
  old_value: unknown
  new_value: unknown
}

export interface ValidateChangeSetResult {
  /** 预校验错误（含 op 位置前缀，server 侧用 `；` 拼接返回 400） */
  errors: string[]
  /** 通过预校验时的规范化 operations（可直接入库保存为 pending；commit 时仍会全量重校） */
  normalized?: ChangeSetOp[]
}

export interface ApplyChangeSetResult {
  /** 非空 = 全批拒绝（看板零变化）；空数组 = 全部通过 */
  errors: string[]
  /** 成功时的新 doc（不改写入参；products / meta 原样透传；groups 随 op 更新） */
  doc?: ChangeSetBoardDoc
  /** 逐字段变更记录（供审计；幂等同值 patch 不产生记录） */
  changes?: ChangeSetFieldChange[]
  /** create 的 client_ref → 服务端分配 id 映射（按 operations 顺序） */
  created?: ChangeSetCreatedItem[]
  /** group_create 的 client_ref → 服务端分配分组 id 映射（v2-M2，按 operations 顺序） */
  createdGroups?: ChangeSetCreatedGroup[]
  /** 本 change-set 新登记的成员（整个 set 内 pending 去重后一次性并入） */
  newMembers?: Member[]
}

/** 预留上下文（当前 create 缺省 status 恒为 '待执行'，id 由内容哈希确定性分配） */
export interface ApplyChangeSetContext {
  now?: string
}

/**
 * create 的服务端 id 分配：内容哈希确定性 id（沿用 import-core autoId 的 auto-<sha1 16> 风格），
 * 哈希输入追加 client_ref 与 op 序号 —— 同一 change-set 内容重试得到同一 id（协议 §5.4），
 * 同 set 内两张完全相同的卡（不同 op 位）也不会撞 id。
 */
export function newChangeSetItemId(
  fields: { title: string; type: string; publish_at: string; product_id: string },
  clientRef: string | null,
  opIndex: number,
): string {
  const { title, type, publish_at, product_id } = fields
  return `auto-${sha1Hex(`${title}|${type}|${publish_at}|${product_id}|${clientRef ?? ''}|#${opIndex}`).slice(0, 16)}`
}

// ---------------------------------------------------------------------------
// create.item 预校验 + 归一化（负责人姓名不在此解析，保留 trim 后原串，commit 时登记）
// ---------------------------------------------------------------------------
function normalizeCreateItem(
  raw: Record<string, unknown>,
  label: string,
): { errors: string[]; item?: Record<string, unknown> } {
  const errors: string[] = []
  const keys = Object.keys(raw)
  if (keys.includes('id')) errors.push(`${label} 不允许指定 id（服务端分配）`)
  const unknown = keys.filter((k) => k !== 'id' && !(PATCH_FIELDS as readonly string[]).includes(k))
  if (unknown.length > 0) errors.push(`${label} 不支持字段: ${unknown.join(', ')}`)
  if (errors.length > 0) return { errors }

  const item: Record<string, unknown> = {}

  // title：必填非空
  const title = String(raw.title ?? '').trim()
  if (!title) errors.push(`${label}: title 必填且非空`)
  else item.title = title

  // publish_at：必填，归一化
  if (raw.publish_at === undefined || String(raw.publish_at).trim() === '') {
    errors.push(`${label}: publish_at 必填`)
  } else {
    const v = normalizePublishAt(raw.publish_at)
    if (!v) {
      errors.push(
        `${label}: publish_at 无法解析: "${raw.publish_at}"（接受 YYYY-MM-DDTHH:mm / YYYY-MM-DD HH:mm / YYYY/M/D H:mm）`,
      )
    } else item.publish_at = v
  }

  if ('type' in raw) {
    const v = String(raw.type ?? '').trim()
    if (!(TYPES as readonly string[]).includes(v))
      errors.push(`${label}: type 非法: "${v}"，合法值: ${TYPES.join(' / ')}`)
    else item.type = v
  }
  if ('status' in raw) {
    const v = String(raw.status ?? '').trim()
    if (!(STATUSES as readonly string[]).includes(v))
      errors.push(`${label}: status 非法: "${v}"，合法值: ${STATUSES.join(' / ')}`)
    else item.status = v
  }
  if ('product_id' in raw) item.product_id = String(raw.product_id ?? '').trim()
  // 负责人：仅 trim 保留，姓名 → id 的解析与登记发生在 apply（有目录上下文）
  if ('content_owner_id' in raw) item.content_owner_id = String(raw.content_owner_id ?? '').trim()
  if ('delivery_owner_id' in raw) item.delivery_owner_id = String(raw.delivery_owner_id ?? '').trim()
  for (const name of ['roi', 'propagation_4h', 'engagement_4h'] as const) {
    if (name in raw) {
      const r = normalizeMetric(raw[name], name)
      if (r.error) errors.push(`${label}: ${r.error}`)
      else item[name] = r.value
    }
  }
  if ('comment' in raw) item.comment = String(raw.comment ?? '')
  if ('links' in raw) {
    const r = normalizeLinks(raw.links)
    if (r.error) errors.push(`${label}: ${r.error}`)
    else item.links = r.value
  }
  // bg_color / dimmed（v2-M1b）：与 patch-core 同口径——hex 归一化 + 旧 token 兼容；
  // null/空串 = 未设置
  if ('bg_color' in raw && raw.bg_color !== null && String(raw.bg_color ?? '').trim() !== '') {
    const rawV = String(raw.bg_color).trim()
    const v = normalizeBgColor(rawV)
    if (!v) errors.push(`${label}: bg_color 非法: "${rawV}"，合法值: #rgb / #rrggbb 十六进制色值`)
    else item.bg_color = v
  }
  if ('dimmed' in raw) {
    if (typeof raw.dimmed !== 'boolean') {
      errors.push(`${label}: dimmed 非法: 期望 boolean，实际 ${JSON.stringify(raw.dimmed)}`)
    } else if (raw.dimmed) {
      item.dimmed = true
    }
  }
  // group_id（v2-M2 统一分组模型）：非空字符串 trim 保留原串（存在性/同 set client_ref
  // 解析在 apply，有看板上下文）；null/空串 = 显式归「未分组」（保留 null 哨兵，
  // apply 不再做日期归属解析——显式值优先）；键缺省 = 未显式指定（apply 走写入时归属解析）
  if ('group_id' in raw) {
    if (raw.group_id === null || String(raw.group_id ?? '').trim() === '') {
      ;(item as Record<string, unknown>).group_id = null
    } else {
      item.group_id = String(raw.group_id).trim()
    }
  }

  if (errors.length > 0) return { errors }
  return { errors, item }
}

// ---------------------------------------------------------------------------
// patch.changes 预校验：白名单与逐字段格式校验复用 applyItemPatch 本身（虚拟卡承载，
// 保证与单卡 PATCH 逐字同规则同文案）；归一化取值时排除负责人字段（解析留待 commit）。
// ---------------------------------------------------------------------------
const OWNER_FIELDS = ['content_owner_id', 'delivery_owner_id'] as const
const VALIDATION_DUMMY: ContentItem = {
  id: '__validate__',
  title: '校验占位',
  type: '图文',
  publish_at: '2000-01-01T00:00',
  roi: null,
  comment: '',
  product_id: '',
  status: '已发布', // 避免 gate 在预校验归一化中误清指标
  content_owner_id: '',
  delivery_owner_id: '',
  propagation_4h: null,
  engagement_4h: null,
}

function normalizePatchChanges(
  raw: Record<string, unknown>,
  label: string,
): { errors: string[]; changes?: Record<string, unknown> } {
  const r = applyItemPatch(raw, VALIDATION_DUMMY, { members: [], items: [VALIDATION_DUMMY], orders: {} })
  if (r.unknownFields.length > 0) {
    return { errors: [`${label} 不支持修改的字段: ${r.unknownFields.join(', ')}`] }
  }
  if (r.errors.length > 0 || !r.next) {
    return { errors: r.errors.map((e) => `${label} ${e}`) }
  }
  const changes: Record<string, unknown> = {}
  for (const k of Object.keys(raw)) {
    if ((OWNER_FIELDS as readonly string[]).includes(k)) {
      changes[k] = String(raw[k] ?? '').trim()
    } else if (k === 'bg_color' && (raw[k] === null || raw[k] === undefined || String(raw[k]).trim() === '')) {
      // 移除语义必须显式保留：r.next 里字段已被 delete（undefined），
      // 若直接取 r.next[k]，JSON 入库会丢键、二次应用还会误判为非法 boolean/枚举
      changes[k] = null
    } else if (k === 'group_id' && (raw[k] === null || raw[k] === undefined || String(raw[k]).trim() === '')) {
      // group_id 移除语义同 bg_color（归「未分组」）；非空值保留 trim 原串，
      // 存在性/同 set client_ref 解析留待 commit（预校验无看板上下文）
      changes[k] = null
    } else if (k === 'group_id') {
      changes[k] = String(raw[k]).trim()
    } else if (k === 'dimmed' && raw[k] === false) {
      changes[k] = false
    } else {
      changes[k] = r.next[k as keyof ContentItem]
    }
  }
  return { errors: [], changes }
}

/**
 * operations 结构 + 格式预校验（validateChangeSet 与 applyChangeSet 共用，
 * 保证 commit 时的 core 全量校验与创建时的预校验同一口径）。
 */
function validateOperations(operations: unknown): ValidateChangeSetResult {
  if (!Array.isArray(operations) || operations.length === 0) {
    return { errors: ['operations 须为非空数组'] }
  }
  const errors: string[] = []
  const normalized: ChangeSetOp[] = []
  for (const [i, raw] of operations.entries()) {
    const label = `operations[${i}]`
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      errors.push(`${label} 须为对象`)
      continue
    }
    const op = (raw as { op?: unknown }).op
    if (op === 'create') {
      const rec = raw as { client_ref?: unknown; item?: unknown }
      let client_ref: string | undefined
      if (rec.client_ref !== undefined) {
        client_ref = String(rec.client_ref).trim()
        if (!client_ref) errors.push(`${label}.client_ref 须为非空字符串`)
      }
      if (!rec.item || typeof rec.item !== 'object' || Array.isArray(rec.item)) {
        errors.push(`${label}.item 须为对象`)
        continue
      }
      const v = normalizeCreateItem(rec.item as Record<string, unknown>, `${label}.item`)
      errors.push(...v.errors)
      if (v.item) {
        normalized.push({
          op: 'create',
          ...(client_ref !== undefined ? { client_ref } : {}),
          item: v.item as Partial<Omit<ContentItem, 'id'>>,
        })
      }
    } else if (op === 'patch') {
      const rec = raw as { item_id?: unknown; changes?: unknown }
      const item_id = String(rec.item_id ?? '').trim()
      if (!item_id) errors.push(`${label}.item_id 必填且非空`)
      if (!rec.changes || typeof rec.changes !== 'object' || Array.isArray(rec.changes)) {
        errors.push(`${label}.changes 须为对象`)
        continue
      }
      const v = normalizePatchChanges(rec.changes as Record<string, unknown>, `${label}.changes`)
      errors.push(...v.errors)
      if (v.changes && item_id) normalized.push({ op: 'patch', item_id, changes: v.changes })
    } else if (op === 'group_create') {
      // v2-M2 F3：group 对象 + 非空 name；client_ref 供同 set 后续 op 引用
      const rec = raw as { client_ref?: unknown; group?: unknown }
      let client_ref: string | undefined
      if (rec.client_ref !== undefined) {
        client_ref = String(rec.client_ref).trim()
        if (!client_ref) errors.push(`${label}.client_ref 须为非空字符串`)
      }
      if (!rec.group || typeof rec.group !== 'object' || Array.isArray(rec.group)) {
        errors.push(`${label}.group 须为对象`)
        continue
      }
      const name = String((rec.group as { name?: unknown }).name ?? '').trim()
      if (!name) {
        errors.push(`${label}.group.name 必填且非空`)
        continue
      }
      normalized.push({ op: 'group_create', ...(client_ref !== undefined ? { client_ref } : {}), group: { name } })
    } else if (op === 'group_patch') {
      const rec = raw as { group_id?: unknown; changes?: unknown }
      const labelErrs: string[] = []
      const group_id = String(rec.group_id ?? '').trim()
      if (!group_id) labelErrs.push(`${label}.group_id 必填且非空`)
      if (!rec.changes || typeof rec.changes !== 'object' || Array.isArray(rec.changes)) {
        labelErrs.push(`${label}.changes 须为对象`)
        errors.push(...labelErrs)
        continue
      }
      const rc = rec.changes as Record<string, unknown>
      const unknown = Object.keys(rc).filter((k) => k !== 'name' && k !== 'before_group_id')
      if (unknown.length > 0) {
        errors.push(...labelErrs, `${label}.changes 不支持字段: ${unknown.join(', ')}`)
        continue
      }
      const changes: { name?: string; before_group_id?: string | null } = {}
      if ('name' in rc) {
        const name = String(rc.name ?? '').trim()
        if (!name) labelErrs.push(`${label}.changes.name 须为非空字符串`)
        else changes.name = name
      }
      if ('before_group_id' in rc) {
        if (rc.before_group_id === null) changes.before_group_id = null
        else {
          const ref = String(rc.before_group_id ?? '').trim()
          if (!ref) labelErrs.push(`${label}.changes.before_group_id 须为非空字符串或 null（= 移到末尾）`)
          else changes.before_group_id = ref
        }
      }
      if (!('name' in rc) && !('before_group_id' in rc)) {
        labelErrs.push(`${label}.changes 须含 name 或 before_group_id`)
      }
      errors.push(...labelErrs)
      if (labelErrs.length === 0) normalized.push({ op: 'group_patch', group_id, changes })
    } else if (op === 'group_delete') {
      const rec = raw as { group_id?: unknown; move_to?: unknown }
      const group_id = String(rec.group_id ?? '').trim()
      if (!group_id) {
        errors.push(`${label}.group_id 必填且非空`)
        continue
      }
      let move_to: string | undefined
      if (rec.move_to !== undefined) {
        move_to = String(rec.move_to ?? '').trim()
        if (!move_to) errors.push(`${label}.move_to 须为非空字符串（目标分组 id / 同 set client_ref）`)
      }
      normalized.push({ op: 'group_delete', group_id, ...(move_to !== undefined ? { move_to } : {}) })
    } else {
      errors.push(
        `${label}.op 非法: "${String(op)}"，合法值: create / patch / group_create / group_patch / group_delete`,
      )
    }
  }
  if (errors.length > 0) return { errors }
  return { errors, normalized }
}

/**
 * 创建变更集预校验（协议 §5.4）：格式类错误尽早暴露。
 * 通过时返回 normalized（规范化 operations，可直接入库保存为 pending）。
 * 并发与存在性检查不在此阶段：base_version 比对与 item_id 命中发生在 commit。
 */
export function validateChangeSet(input: unknown): ValidateChangeSetResult {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { errors: ['请求体须为对象'] }
  }
  return validateOperations((input as { operations?: unknown }).operations)
}

/**
 * 在 board doc 快照上按序应用 change-set operations（协议 §5.6 事务内的 core 全量校验一步）。
 * 纯函数：不改写 doc / operations；任何一步失败返回完整 errors（全批拒绝，不产生部分结果）；
 * 全部通过返回 { doc', changes, created, newMembers }。
 */
export function applyChangeSet(
  doc: ChangeSetBoardDoc,
  operations: unknown,
  ctx: ApplyChangeSetContext = {},
): ApplyChangeSetResult {
  void ctx // 预留上下文参数（见 ApplyChangeSetContext 注释）

  // 1. 结构 + 逐字段全量重校（commit 语义：不信任创建时的预校验结果）
  const v = validateOperations(operations)
  if (!v.normalized) return { errors: v.errors }
  const ops = v.normalized

  // 2. 2000 张硬上限：超限全批拒绝（协议 §9）
  const createCount = ops.filter((o) => o.op === 'create').length
  if (doc.items.length + createCount > BOARD_ITEM_LIMIT) {
    return {
      errors: [
        `单板 ${BOARD_ITEM_LIMIT} 张上限：当前 ${doc.items.length} 张，本变更集新增 ${createCount} 张，超限已全批拒绝`,
      ],
    }
  }

  // 3. 按序应用（运行态副本：同 set 内前序 op 的结果对后续 op 可见）
  let items = [...doc.items]
  const orders: Orders = { ...doc.orders }
  const ids = new Set(items.map((it) => it.id))
  const pendingMembers: Member[] = [] // 整个 set 内 pending 去重，成功后一次性并入 members
  const changes: ChangeSetFieldChange[] = []
  const created: ChangeSetCreatedItem[] = []
  const errors: string[] = []

  // v2-M2 F3 统一分组模型：分组运行态（groups 数组序 = 列顺序）+ client_ref 解析表
  let groups: Group[] = (doc.groups ?? []).map((g) => ({ ...g }))
  let groupsTouched = false // groups 数组是否发生过结构变化（决定 doc 是否替换 groups 键）
  const createdGroups: ChangeSetCreatedGroup[] = []
  const groupRefToId = new Map<string, string>() // 同 set 内 client_ref → 新建分组 id（set 内前序可见）
  /** 分组引用解析：已有分组 id 优先，其次同 set client_ref；未命中 → null */
  const resolveGroup = (raw: string): string | null => {
    if (groups.some((g) => g.id === raw)) return raw
    return groupRefToId.get(raw) ?? null
  }

  for (const [i, op] of ops.entries()) {
    const label = `operations[${i}]`
    if (op.op === 'group_create') {
      // 服务端分配确定性内容哈希 id；client_ref 登记进 set 内引用表（重复 client_ref 拒绝）
      const name = op.group.name
      const clientRef = op.client_ref ?? null
      if (clientRef !== null && groupRefToId.has(clientRef)) {
        errors.push(`${label}: client_ref 重复: "${clientRef}"（同一变更集内须唯一）`)
        continue
      }
      const gid = newChangeSetGroupId(name, clientRef, i)
      if (groups.some((g) => g.id === gid)) {
        errors.push(`${label}: 分组 id 重复: ${gid}`)
        continue
      }
      // 统一分组模型：分组总数上限 61（虚拟「未分组」列不占名额）
      if (groups.length >= MAX_GROUPS) {
        errors.push(`${label}: 分组已达上限 ${MAX_GROUPS} 个，无法新建「${name}」`)
        continue
      }
      groups.push({ id: gid, name })
      groupsTouched = true
      if (clientRef !== null) groupRefToId.set(clientRef, gid)
      createdGroups.push({ client_ref: clientRef, id: gid })
      changes.push({ item_id: gid, field: 'group', old_value: null, new_value: name })
    } else if (op.op === 'group_patch') {
      const gid = resolveGroup(op.group_id)
      if (!gid) {
        errors.push(`${label}: 分组不存在: ${op.group_id}`)
        continue
      }
      const idx = groups.findIndex((g) => g.id === gid)
      const g = groups[idx]
      if (op.changes.name !== undefined && op.changes.name !== g.name) {
        changes.push({ item_id: gid, field: 'group.name', old_value: g.name, new_value: op.changes.name })
        groups[idx] = { ...g, name: op.changes.name }
        groupsTouched = true
      }
      if (op.changes.before_group_id !== undefined) {
        // 调列序：null = 移到末尾；否则插到目标分组之前（不可指向自身）
        let toIdx = groups.length // 末尾
        if (op.changes.before_group_id !== null) {
          const beforeId = resolveGroup(op.changes.before_group_id)
          if (!beforeId) {
            errors.push(`${label}.changes before_group_id 分组不存在: ${op.changes.before_group_id}`)
            continue
          }
          if (beforeId === gid) {
            errors.push(`${label}.changes before_group_id 不能是被移动分组自身`)
            continue
          }
          toIdx = groups.findIndex((x) => x.id === beforeId)
        }
        const fromIdx = groups.findIndex((x) => x.id === gid)
        // 幂等：位置未变（已在目标前一位 / 已在末尾）不产生变更记录
        const targetPos = toIdx > fromIdx ? toIdx - 1 : toIdx
        if (fromIdx !== targetPos) {
          const [moved] = groups.splice(fromIdx, 1)
          groups.splice(targetPos, 0, moved)
          changes.push({ item_id: gid, field: 'group.order', old_value: fromIdx, new_value: targetPos })
          groupsTouched = true
        }
      }
    } else if (op.op === 'group_delete') {
      const gid = resolveGroup(op.group_id)
      if (!gid) {
        errors.push(`${label}: 分组不存在: ${op.group_id}`)
        continue
      }
      const g = groups.find((x) => x.id === gid)!
      const inGroup = items.filter((it) => it.group_id === gid)
      // move_to 可缺省 = 组内卡片归「未分组」虚拟列（2026-09-08 终稿）；
      // 显式给出时须指向已存在分组（不能是被删分组自身）
      let moveToId: string | null = null
      if (op.move_to !== undefined) {
        moveToId = resolveGroup(op.move_to)
        if (!moveToId) {
          errors.push(`${label}: move_to 分组不存在: ${op.move_to}`)
          continue
        }
        if (moveToId === gid) {
          errors.push(`${label}: move_to 不能是被删分组自身`)
          continue
        }
      }
      groups = groups.filter((x) => x.id !== gid)
      groupsTouched = true
      if (moveToId !== null) {
        items = items.map((it) => (it.group_id === gid ? { ...it, group_id: moveToId } : it))
      } else {
        // 归未分组 = 移除 group_id 字段（保持 doc 干净，不落 null）
        items = items.map((it) => {
          if (it.group_id !== gid) return it
          const next = { ...it }
          delete next.group_id
          return next
        })
      }
      for (const it of inGroup) {
        changes.push({ item_id: it.id, field: 'group_id', old_value: gid, new_value: moveToId })
      }
      changes.push({ item_id: gid, field: 'group', old_value: g.name, new_value: null })
    } else if (op.op === 'create') {
      const f = op.item as Record<string, unknown>
      const title = String(f.title)
      const type = String(f.type ?? '图文')
      const publish_at = String(f.publish_at)
      const product_id = String(f.product_id ?? '')
      const clientRef = op.client_ref ?? null
      const id = newChangeSetItemId({ title, type, publish_at, product_id }, clientRef, i)
      if (ids.has(id)) {
        errors.push(`${label}: id 重复: ${id}`)
        continue
      }
      // 负责人解析：未知姓名登记新成员；pending 参与命中与 id 分配（整个 set 内去重）
      const memberScope = [...doc.members, ...pendingMembers]
      let content_owner_id = ''
      let delivery_owner_id = ''
      if ('content_owner_id' in f) {
        const r = resolveOwnerPatch(f.content_owner_id, memberScope)
        content_owner_id = r.id
        if (r.registered) pendingMembers.push(r.registered)
      }
      if ('delivery_owner_id' in f) {
        const r = resolveOwnerPatch(f.delivery_owner_id, memberScope)
        delivery_owner_id = r.id
        if (r.registered) pendingMembers.push(r.registered)
      }
      // group_id（v2-M2 统一分组模型）：显式非空 → 解析引用（已有分组 id / 同 set client_ref），
      // 悬空拒绝（写入严格）；显式 null = 归未分组（不解析）；键缺省 → 写入时归属解析：
      // 挂入组名 == publish_at 日期的组，无同名日期组 → 未分组（绝不自动建组）
      let groupId: string | undefined
      if (typeof f.group_id === 'string' && f.group_id) {
        const resolved = resolveGroup(f.group_id)
        if (!resolved) {
          errors.push(`${label}: group_id 不存在: "${f.group_id}"（须指向看板已有分组；同变更集内可先 group_create 再用其 client_ref 引用）`)
          continue
        }
        groupId = resolved
      } else if (!('group_id' in f)) {
        groupId = resolveWriteTimeGroup(groups, publish_at)
      }
      // 指标 gate：最终 status ≠ 已发布 → 三指标强制 null（与 PATCH 同口径）
      const status = (f.status ?? '待执行') as ContentItem['status']
      const gate = status !== '已发布'
      const item: ContentItem = {
        id,
        title,
        type: type as ContentItem['type'],
        publish_at,
        roi: gate ? null : ((f.roi as number | null) ?? null),
        comment: String(f.comment ?? ''),
        product_id,
        status,
        content_owner_id,
        delivery_owner_id,
        propagation_4h: gate ? null : ((f.propagation_4h as number | null) ?? null),
        engagement_4h: gate ? null : ((f.engagement_4h as number | null) ?? null),
        ...(f.links ? { links: f.links as Link[] } : {}),
        // v2-M1：create 支持 bg_color / dimmed（校验在 normalizeCreateItem；false/缺省不写字段）
        ...(f.bg_color ? { bg_color: f.bg_color as ContentItem['bg_color'] } : {}),
        ...(f.dimmed === true ? { dimmed: true } : {}),
        // v2-M2：create 支持 group_id（引用已解析为真实分组 id；缺省 = 未分组）
        ...(groupId ? { group_id: groupId } : {}),
      }
      // 同日多张新卡按 ops 顺序追加当日列尾（对运行态取 nextOrder）；已有卡片顺序不动
      orders[id] = nextOrder(items, orders, publishDateOf(item))
      items.push(item)
      ids.add(id)
      created.push({ client_ref: clientRef, id })
      // 新建卡审计：逐字段 old_value = null
      for (const [field, value] of Object.entries(item)) {
        changes.push({ item_id: id, field, old_value: null, new_value: value })
      }
    } else {
      const target = items.find((it) => it.id === op.item_id)
      if (!target) {
        errors.push(`${label}: 卡片不存在: ${op.item_id}`)
        continue
      }
      // group_id 引用解析（v2-M2）：同 set client_ref → 真实分组 id；非空且不可解析 → 拒绝。
      // null（移除语义）原样透传给 applyItemPatch
      const rawChanges = { ...op.changes }
      if ('group_id' in rawChanges && rawChanges.group_id !== null) {
        const rawGid = String(rawChanges.group_id)
        const resolved = resolveGroup(rawGid)
        if (!resolved) {
          errors.push(`${label}.changes group_id 不存在: "${rawGid}"（须指向看板已有分组；同变更集内可先 group_create 再用其 client_ref 引用）`)
          continue
        }
        rawChanges.group_id = resolved
      }
      const r = applyItemPatch(rawChanges, target, {
        members: [...doc.members, ...pendingMembers],
        items,
        orders,
        groups,
      })
      // 白名单/格式在 validateOperations 已拦截；此处防御性收集（同一套规则，文案一致）
      if (r.unknownFields.length > 0) {
        errors.push(`${label}.changes 不支持修改的字段: ${r.unknownFields.join(', ')}`)
        continue
      }
      if (r.errors.length > 0 || !r.next) {
        errors.push(...r.errors.map((e) => `${label}.changes ${e}`))
        continue
      }
      pendingMembers.push(...r.pendingMembers)
      // 跨列（显式 group_id / publish_at 归属解析）→ 目标列列尾（对运行态取 nextOrder，多次移入同列依次后移）
      if (r.orderUpdate) orders[r.orderUpdate.id] = r.orderUpdate.order
      items = items.map((it) => (it.id === target.id ? r.next! : it))
      for (const c of r.changes) {
        changes.push({ item_id: target.id, field: c.field, old_value: c.old_value, new_value: c.new_value })
      }
    }
  }

  // 4. 全批拒绝语义：任何一步失败 → 看板零变化，返回完整 errors
  if (errors.length > 0) return { errors }

  // groups 仅在被 op 触及时替换（未触及原样透传，保持 doc 干净）
  const nextDoc: ChangeSetBoardDoc = { ...doc, items, orders, members: [...doc.members, ...pendingMembers] }
  if (groupsTouched) nextDoc.groups = groups
  else if (doc.groups) nextDoc.groups = doc.groups

  return {
    errors: [],
    doc: nextDoc,
    changes,
    created,
    createdGroups,
    newMembers: pendingMembers,
  }
}
