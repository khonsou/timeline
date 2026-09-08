import type { ContentItem } from '../types/content'

// ---------------------------------------------------------------------------
// 视图层：看板摆放状态（纯展示，随拖拽变化）。
// v2-M2 统一分组模型：列归属只看 group_id（缺省/'' = 虚拟「未分组」列），
// publish_at 与分组彻底脱钩（纯信息字段，时间胶囊照常显示）；
// 列内顺序由独立的 orders 表维护，实体上不存顺序。
// ---------------------------------------------------------------------------

/** 列内顺序表：contentId → 排序权重（越小越靠上） */
export type Orders = Record<string, number>

/** publish_at 的日期部分（纯信息展示 / 迁移与写入时归属解析用，不再驱动分桶） */
export const publishDateOf = (item: ContentItem): string => item.publish_at.slice(0, 10)

/** publish_at 的时分部分（卡片时间胶囊展示用） */
export const publishTimeOf = (item: ContentItem): string => item.publish_at.slice(11, 16)

// ---------------------------------------------------------------------------
// v2-M2 F3 统一分组模型：列归属 key = group_id（'' = 未分组）。
// orders 是全局权重：同一 key 桶内按 order 升序，跨桶拖拽按目标插入位重取 order。
// ---------------------------------------------------------------------------

/** 卡片的列归属 key（group_id；缺省 = '' 未分组） */
export const columnKeyOf = (item: ContentItem): string => item.group_id ?? ''

/** 某列（key 桶）内的条目：按 orders 升序，order 相同按 items 数组原序（稳定） */
export function cardsInColumn(items: ContentItem[], orders: Orders, key: string): ContentItem[] {
  return items
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => columnKeyOf(c) === key)
    .sort((a, b) => (orders[a.c.id] ?? 0) - (orders[b.c.id] ?? 0) || a.i - b.i)
    .map(({ c }) => c)
}

/** 某列（key 桶）内末尾的下一个 order */
export function nextOrderInColumn(items: ContentItem[], orders: Orders, key: string): number {
  const col = cardsInColumn(items, orders, key)
  return col.length ? (orders[col[col.length - 1].id] ?? 0) + 1 : 0
}

/** 某分组列内的条目（groupId 缺省/'' = 虚拟「未分组」列） */
export function cardsInGroup(items: ContentItem[], orders: Orders, groupId?: string): ContentItem[] {
  return cardsInColumn(items, orders, groupId ?? '')
}

/** 某分组列内末尾的下一个 order */
export function nextOrderInGroup(items: ContentItem[], orders: Orders, groupId?: string): number {
  return nextOrderInColumn(items, orders, groupId ?? '')
}

/** 同日期桶内的条目（导入/初始排序等按 publish_at 日期分桶的场景用，与看板列无关） */
export function cardsInDay(items: ContentItem[], orders: Orders, date: string): ContentItem[] {
  return items
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => publishDateOf(c) === date)
    .sort((a, b) => (orders[a.c.id] ?? 0) - (orders[b.c.id] ?? 0) || a.i - b.i)
    .map(({ c }) => c)
}

/** 同日期桶内末尾的下一个 order（导入初始排序用） */
export function nextOrder(items: ContentItem[], orders: Orders, date: string): number {
  const col = cardsInDay(items, orders, date)
  return col.length ? (orders[col[col.length - 1].id] ?? 0) + 1 : 0
}

/**
 * 是否已发布（v14 起读 status 字段：仅 '已发布' 解锁指标；旧数据无 status 时
 * 按 publish_at ≤ now 兜底推导——加载迁移（App.validateState）已保证渲染前必有 status）
 */
export const isPublished = (item: ContentItem, now: Date = new Date()): boolean =>
  item.status
    ? item.status === '已发布'
    : item.publish_at <= `${fmtDate(now)}T${pad2(now.getHours())}:${pad2(now.getMinutes())}`

const pad2 = (n: number) => String(n).padStart(2, '0')
function fmtDate(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}
