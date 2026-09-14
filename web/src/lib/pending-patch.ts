/**
 * M4 pending-patch：本地未推送变更的 item 级差分队列（同步层内部机制，组件层无感）。
 *
 * 语义：
 *   pending = diff(base, local)
 *   base  = 最近一次与服务端对齐的快照（versionRef 所指版本的内容）
 *   local = 用户当前看到/编辑的 doc
 *
 * 重放时机：
 *   1. PUT 收到 409 VERSION_CONFLICT → 整板 GET 拿最新快照 → merged = applyPatch(远端, pending)
 *      → 带新 version 重试 PUT（冲突粒度从整板 LWW 细化到 item 字段级）
 *   2. 轮询/首次拉取拿到新快照且本地有未推送变更 → 同样重放，新快照成为 base，
 *      pending 始终保持在 base 之上（远端改动不会再整板覆盖本地未推送编辑）
 *   3. 离线补推：离线期间积累的编辑本就在 local 与缓存的 pending 里，恢复在线后走同一路径
 *
 * 持久化：pending 随缓存落盘（localStorage `timeline-board-v4:b:<boardId>` 的 `_sync` 键），
 * 刷新/重开页面后首次拉取仍可把未推送编辑重放到最新快照，不静默丢编辑。
 */
import type { ContentItem, Group, Member } from '@timeline/core/types'
import { mergeCommentsById } from '@timeline/core/comment-core'
import type { Orders } from '@timeline/core/board-view'
import type { BoardDoc } from '@/lib/board-doc'
import type { Product } from '@/lib/content-data'

export interface ItemPatch {
  /** 相对 base 变化的字段子集（应用到对端快照时只覆盖这些字段） */
  fields: Partial<ContentItem>
  /** 本地完整快照：对端并发删除同卡时以整张卡复活（不静默丢编辑） */
  full: ContentItem
}

export interface DocPatch {
  added: ContentItem[] // 本地新增卡（base 中不存在）
  patched: Record<string, ItemPatch> // 两端都有、本地改了字段
  removed: string[] // 本地删除的卡 id
  orders: Record<string, number> // 新增/变化的 order
  ordersRemoved: string[] // 本地移除的 order 键
  productsUpsert: Product[] // 目录：新增/改名（按 id）
  productsRemoved: string[]
  membersUpsert: Member[]
  membersRemoved: string[]
  /** v2-M2：groups 整体替换（数组序 = 列顺序，顺序敏感不做 upsert 差分）；null = 移除；undefined = 未变化 */
  groups?: Group[] | null
}

export const emptyPatch = (): DocPatch => ({
  added: [],
  patched: {},
  removed: [],
  orders: {},
  ordersRemoved: [],
  productsUpsert: [],
  productsRemoved: [],
  membersUpsert: [],
  membersRemoved: [],
})

/** 字段值相等（基本类型 Object.is；links 等数组/对象走 JSON 比较） */
const sameValue = (a: unknown, b: unknown): boolean =>
  Object.is(a, b) || JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

/** diff(base, local)：把 base 变成 local 所需的 item 级变更；幂等键为 id，忽略 items 数组顺序 */
export function diffDocs(base: BoardDoc, local: BoardDoc): DocPatch {
  const p = emptyPatch()
  const baseById = new Map(base.items.map((it) => [it.id, it]))
  const localIds = new Set<string>()
  for (const it of local.items) {
    localIds.add(it.id)
    const b = baseById.get(it.id)
    if (!b) {
      p.added.push(it)
      continue
    }
    const fields: Partial<ContentItem> = {}
    const keys = new Set([...Object.keys(b), ...Object.keys(it)])
    let n = 0
    for (const k of keys) {
      if (k === 'id') continue
      const bv = (b as unknown as Record<string, unknown>)[k]
      const lv = (it as unknown as Record<string, unknown>)[k]
      if (!sameValue(bv, lv)) {
        ;(fields as Record<string, unknown>)[k] = lv
        n++
      }
    }
    if (n > 0) p.patched[it.id] = { fields, full: it }
  }
  for (const it of base.items) if (!localIds.has(it.id)) p.removed.push(it.id)

  for (const [id, o] of Object.entries(local.orders)) {
    if (base.orders[id] !== o) p.orders[id] = o
  }
  for (const id of Object.keys(base.orders)) {
    if (!(id in local.orders)) p.ordersRemoved.push(id)
  }

  const diffCatalog = <T extends { id: string }>(
    b: T[],
    l: T[],
  ): { upsert: T[]; removed: string[] } => {
    const bById = new Map(b.map((x) => [x.id, x]))
    const lIds = new Set(l.map((x) => x.id))
    return {
      upsert: l.filter((x) => {
        const bx = bById.get(x.id)
        return !bx || !sameValue(bx, x)
      }),
      removed: b.filter((x) => !lIds.has(x.id)).map((x) => x.id),
    }
  }
  const pd = diffCatalog(base.products, local.products)
  p.productsUpsert = pd.upsert
  p.productsRemoved = pd.removed
  const md = diffCatalog(base.members, local.members)
  p.membersUpsert = md.upsert
  p.membersRemoved = md.removed

  // v2-M2：groups 顺序敏感（数组序 = 列顺序）→ 整体替换差分
  if (!sameValue(base.groups ?? null, local.groups ?? null)) p.groups = local.groups ?? null
  return p
}

export function patchIsEmpty(p: DocPatch): boolean {
  return (
    p.added.length === 0 &&
    Object.keys(p.patched).length === 0 &&
    p.removed.length === 0 &&
    Object.keys(p.orders).length === 0 &&
    p.ordersRemoved.length === 0 &&
    p.productsUpsert.length === 0 &&
    p.productsRemoved.length === 0 &&
    p.membersUpsert.length === 0 &&
    p.membersRemoved.length === 0 &&
    p.groups === undefined
  )
}

/** 结构相等（id 键控，忽略 items 数组顺序与 meta） */
export const docsEqual = (a: BoardDoc, b: BoardDoc): boolean => patchIsEmpty(diffDocs(a, b))

/**
 * applyPatch(base, patch)：把本地差分重放到（通常是远端最新）快照之上，返回新 doc。
 *  - patched 命中存在的卡 → 只覆盖变更字段（对端同事改的其它字段保留）
 *  - patched 命中已被对端删除的卡 → 以本地完整快照复活（不静默丢编辑）
 *  - removed 优先于 patched（本地删掉的卡不因对端改动而复活）
 */
export function applyPatch(base: BoardDoc, patch: DocPatch): BoardDoc {
  const removed = new Set(patch.removed)
  const items: ContentItem[] = []
  for (const it of base.items) {
    if (removed.has(it.id)) continue
    const pt = patch.patched[it.id]
    if (!pt) {
      items.push(it)
      continue
    }
    const merged = { ...it, ...pt.fields }
    // v2-M4：comments 是数组——字段级整体覆盖（LWW）会让「两人同时评论同一张卡」丢一条；
    // 重放时按 id 键控 union（双方独有都保留，同 id 以远端/base 为准，按 created_at 升序）。
    // 其余字段保持字段级覆盖语义。diff 侧不动（仍是整组字段级比较）。
    if ('comments' in pt.fields) {
      const mc = mergeCommentsById(it.comments, pt.fields.comments)
      if (mc) merged.comments = mc
      else delete merged.comments
    }
    items.push(merged)
  }
  const present = new Set(items.map((it) => it.id))
  for (const it of patch.added) {
    if (!present.has(it.id)) {
      items.push(it)
      present.add(it.id)
    }
  }
  for (const [id, pt] of Object.entries(patch.patched)) {
    if (!removed.has(id) && !present.has(id)) {
      items.push({ ...pt.full }) // 对端删了、本地在改 → 复活
      present.add(id)
    }
  }

  const orders: Orders = { ...base.orders }
  for (const id of patch.ordersRemoved) delete orders[id]
  Object.assign(orders, patch.orders)

  const applyCatalog = <T extends { id: string }>(b: T[], upsert: T[], rem: string[]): T[] => {
    const remSet = new Set(rem)
    const upById = new Map(upsert.map((x) => [x.id, x]))
    const out = b.filter((x) => !remSet.has(x.id)).map((x) => upById.get(x.id) ?? x)
    const have = new Set(out.map((x) => x.id))
    for (const x of upsert) if (!have.has(x.id)) out.push(x)
    return out
  }

  return {
    items,
    orders,
    products: applyCatalog(base.products, patch.productsUpsert, patch.productsRemoved),
    members: applyCatalog(base.members, patch.membersUpsert, patch.membersRemoved),
    // v2-M2：groups 整体替换（undefined = 沿用 base；null = 移除）
    ...(patch.groups === undefined
      ? base.groups
        ? { groups: base.groups }
        : {}
      : patch.groups
        ? { groups: patch.groups }
        : {}),
    meta: base.meta,
  }
}

/** 缓存里的 pending 做最低限度形状检查（防手改/损坏缓存把同步层搞炸） */
export function sanitizePatch(raw: unknown): DocPatch {
  const p = emptyPatch()
  if (!raw || typeof raw !== 'object') return p
  const r = raw as Partial<DocPatch>
  if (Array.isArray(r.added)) p.added = r.added as ContentItem[]
  if (r.patched && typeof r.patched === 'object' && !Array.isArray(r.patched)) {
    p.patched = r.patched as Record<string, ItemPatch>
  }
  if (Array.isArray(r.removed)) p.removed = (r.removed as unknown[]).filter((x) => typeof x === 'string')
  if (r.orders && typeof r.orders === 'object' && !Array.isArray(r.orders)) {
    p.orders = r.orders as Orders
  }
  if (Array.isArray(r.ordersRemoved)) {
    p.ordersRemoved = (r.ordersRemoved as unknown[]).filter((x) => typeof x === 'string')
  }
  if (Array.isArray(r.productsUpsert)) p.productsUpsert = r.productsUpsert as Product[]
  if (Array.isArray(r.productsRemoved)) {
    p.productsRemoved = (r.productsRemoved as unknown[]).filter((x) => typeof x === 'string')
  }
  if (Array.isArray(r.membersUpsert)) p.membersUpsert = r.membersUpsert as Member[]
  if (Array.isArray(r.membersRemoved)) {
    p.membersRemoved = (r.membersRemoved as unknown[]).filter((x) => typeof x === 'string')
  }
  // v2-M2：groups（数组 / null 移除）最低限度形状检查
  if (Array.isArray(r.groups)) p.groups = r.groups as Group[]
  else if (r.groups === null) p.groups = null
  return p
}
