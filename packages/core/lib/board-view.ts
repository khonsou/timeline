import type { ContentItem } from '../types/content'

// ---------------------------------------------------------------------------
// 视图层：看板摆放状态（纯展示，随拖拽变化）。
// 日列归属从 publish_at 派生；列内顺序由独立的 orders 表维护，实体上不存顺序。
// ---------------------------------------------------------------------------

/** 列内顺序表：contentId → 排序权重（越小越靠上） */
export type Orders = Record<string, number>

/** publish_at 的日期部分（日列归属，派生不冗余存储） */
export const publishDateOf = (item: ContentItem): string => item.publish_at.slice(0, 10)

/** publish_at 的时分部分（卡片时间胶囊展示用） */
export const publishTimeOf = (item: ContentItem): string => item.publish_at.slice(11, 16)

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

/** 某日期列内的条目：按 orders 升序，order 相同按 items 数组原序（稳定） */
export function cardsInDay(items: ContentItem[], orders: Orders, date: string): ContentItem[] {
  return items
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => publishDateOf(c) === date)
    .sort((a, b) => (orders[a.c.id] ?? 0) - (orders[b.c.id] ?? 0) || a.i - b.i)
    .map(({ c }) => c)
}

/** 某日期列内末尾的下一个 order */
export function nextOrder(items: ContentItem[], orders: Orders, date: string): number {
  const col = cardsInDay(items, orders, date)
  return col.length ? (orders[col[col.length - 1].id] ?? 0) + 1 : 0
}
