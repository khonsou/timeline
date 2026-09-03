/**
 * v15 看板文档（BoardDoc）：服务端 doc 的唯一结构 ——
 * 前端四份状态（items / orders / products / members）原样打包 + meta，结构零重构。
 *
 * 本模块同时承载：
 *  1. doc 的校验与 v14 迁移（status/负责人字段补齐）——本地缓存与远端 doc 进 React 前的统一入口
 *  2. 「从本机现有数据初始化」的 legacy 读取：v14 及之前的单板 localStorage 四键
 *     + CLI 生成的 public/data/board.json 种子（两制并存：CLI 数据经首页初始化进板）
 */
import type { ContentItem, ContentType, Member } from '@/types/content'
import {
  MEMBERS,
  PRODUCTS,
  TYPE_KEYS,
  guideCards,
  type Product,
} from '@/lib/content-data'
import { nextOrder, publishDateOf, type Orders } from '@/lib/board-view'
import { STATUSES, mergeMembers, mergeProducts } from '@/lib/import-core'

export interface BoardDoc {
  items: ContentItem[]
  orders: Orders
  products: Product[]
  members: Member[]
  meta: { name: string; created_at: string }
}

// ---------------------------------------------------------------------------
// doc 校验 + v14 迁移（旧数据没有 status/负责人字段时按时间推导补齐，语义与 v14 一致）
// items 允许为空数组（用户删光卡片是合法状态）
// ---------------------------------------------------------------------------
const PUBLISH_AT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/

function validCatalog(arr: unknown): arr is { id: string; name: string }[] {
  return (
    Array.isArray(arr) &&
    arr.every((x) => x && typeof x.id === 'string' && typeof x.name === 'string')
  )
}

/** 校验并迁移 { items, orders }；非法返回 null */
export function validateItemsOrders(parsed: unknown): { items: ContentItem[]; orders: Orders } | null {
  const items = (parsed as { items?: unknown } | null)?.items
  const orders = (parsed as { orders?: unknown } | null)?.orders
  if (
    Array.isArray(items) &&
    items.every(
      (c) =>
        c &&
        typeof c.id === 'string' &&
        typeof c.title === 'string' &&
        typeof c.publish_at === 'string' &&
        PUBLISH_AT_RE.test(c.publish_at) &&
        TYPE_KEYS.includes(c.type as ContentType) &&
        typeof c.product_id === 'string' &&
        typeof c.comment === 'string' &&
        (typeof c.roi === 'number' || c.roi === null) &&
        (typeof c.propagation_4h === 'number' || c.propagation_4h === null) &&
        (typeof c.engagement_4h === 'number' || c.engagement_4h === null),
    ) &&
    orders &&
    typeof orders === 'object' &&
    !Array.isArray(orders) &&
    Object.values(orders).every((v) => typeof v === 'number')
  ) {
    // 兜底：为缺失 order 的条目补齐到当日列末尾
    const patched: Orders = { ...(orders as Orders) }
    for (const item of items as ContentItem[]) {
      if (typeof patched[item.id] !== 'number') {
        patched[item.id] = nextOrder(items as ContentItem[], patched, publishDateOf(item))
      }
    }
    // v14 迁移：status 缺失按时间推导（未来 → 待发布，否则已发布）；负责人缺失置 ''
    const nowKey = Date.now()
    const migrated = (items as ContentItem[]).map((it) => {
      const rawStatus = (it as { status?: unknown }).status
      const status: ContentItem['status'] =
        typeof rawStatus === 'string' && (STATUSES as readonly string[]).includes(rawStatus)
          ? (rawStatus as ContentItem['status'])
          : new Date(it.publish_at).getTime() > nowKey
            ? '待发布'
            : '已发布'
      const co = (it as { content_owner_id?: unknown }).content_owner_id
      const dvo = (it as { delivery_owner_id?: unknown }).delivery_owner_id
      return {
        ...it,
        status,
        content_owner_id: typeof co === 'string' ? co : '',
        delivery_owner_id: typeof dvo === 'string' ? dvo : '',
      }
    })
    return { items: migrated, orders: patched }
  }
  return null
}

/** 校验并迁移整份 doc（远端 doc / 本地缓存进 React 前的唯一入口）；非法返回 null */
export function validateDoc(raw: unknown): BoardDoc | null {
  if (!raw || typeof raw !== 'object') return null
  const io = validateItemsOrders(raw)
  if (!io) return null
  const d = raw as Partial<BoardDoc>
  const meta =
    d.meta && typeof d.meta === 'object' && typeof d.meta.name === 'string'
      ? { name: d.meta.name, created_at: String(d.meta.created_at ?? '') }
      : { name: '', created_at: '' }
  return {
    items: io.items,
    orders: io.orders,
    products: validCatalog(d.products) ? (d.products as Product[]) : [],
    members: validCatalog(d.members) ? (d.members as Member[]) : [],
    meta,
  }
}

/** 新建看板的默认种子 doc：现有 2 张引导卡 + 内置产品/成员目录 */
export function guideDoc(name: string): BoardDoc {
  const g = guideCards()
  return {
    items: g.items,
    orders: g.orders,
    products: [...PRODUCTS],
    members: [...MEMBERS],
    meta: { name, created_at: new Date().toISOString() },
  }
}

// ---------------------------------------------------------------------------
// legacy：v14 及之前的「本机现有数据」（旧 localStorage 四键 + CLI board.json）
// ---------------------------------------------------------------------------
const LEGACY_STATE_KEY = 'timeline-board-v4'
const LEGACY_PRODUCTS_KEY = 'timeline-board-v4:products'
const LEGACY_SEED_PRODUCTS_KEY = 'timeline-board-v4:seedProducts' // v11 遗留 key
const LEGACY_MEMBERS_KEY = 'timeline-board-v4:members'

export interface LegacyData {
  items: ContentItem[]
  orders: Orders
  products: Product[]
  members: Member[]
}

function readLegacyKey(key: string): unknown {
  try {
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

/**
 * 读取本机现有数据（供首页「从本机现有数据初始化」）：
 *  items/orders：旧 localStorage 单板数据优先；否则 CLI 生成的 board.json（含 items 时）
 *  products/members：在内置目录基础上，依次差分合并 旧 localStorage 目录 → board.json 目录
 *  无 items 来源但有任何目录来源（如 --products 独立导入的 board.json）时，
 *  items/orders 落到引导卡——CLI 产品目录导入在 v15 依然可达（初始化出带目录的新板）
 * 返回 null = 本机没有任何可初始化的数据（勾选框禁用）
 */
export async function loadLegacyLocal(): Promise<LegacyData | null> {
  // 1. 候选 items/orders：旧 localStorage > board.json
  let io = validateItemsOrders(readLegacyKey(LEGACY_STATE_KEY))
  let seedProducts: Product[] = []
  let seedMembers: Member[] = []
  if (!io) {
    try {
      const r = await fetch('data/board.json')
      if (r.ok) {
        const seed: unknown = await r.json()
        io = validateItemsOrders(seed) // board.json 无 items 键时 null（如 --products 独立导入）
        const sp = (seed as { products?: unknown } | null)?.products
        if (validCatalog(sp)) seedProducts = sp as Product[]
        const sm = (seed as { members?: unknown } | null)?.members
        if (validCatalog(sm)) seedMembers = sm as Member[]
      }
    } catch {
      // 404 / 解析失败：无种子
    }
  }

  // 2. 目录：内置 → 旧 localStorage → board.json 逐层差分合并
  const legacyProductsRaw = readLegacyKey(LEGACY_PRODUCTS_KEY) ?? readLegacyKey(LEGACY_SEED_PRODUCTS_KEY)
  const legacyMembersRaw = readLegacyKey(LEGACY_MEMBERS_KEY)
  let products = [...PRODUCTS]
  let members = [...MEMBERS]
  if (validCatalog(legacyProductsRaw)) products = mergeProducts(products, legacyProductsRaw).merged
  if (seedProducts.length > 0) products = mergeProducts(products, seedProducts).merged
  if (validCatalog(legacyMembersRaw)) members = mergeMembers(members, legacyMembersRaw).merged
  if (seedMembers.length > 0) members = mergeMembers(members, seedMembers).merged

  const hasAny =
    !!io ||
    validCatalog(legacyProductsRaw) ||
    validCatalog(legacyMembersRaw) ||
    seedProducts.length > 0 ||
    seedMembers.length > 0
  if (!hasAny) return null

  // 3. 只有目录来源（如 --products 独立导入）：items 落到引导卡
  if (!io) {
    const g = guideCards()
    io = { items: g.items, orders: g.orders }
  }
  return { items: io.items, orders: io.orders, products, members }
}
