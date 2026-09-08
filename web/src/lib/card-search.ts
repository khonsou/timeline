/**
 * 卡片匹配逻辑（v2-M1 F5 搜索面板 / v2-M3 F4 详情弹窗「前后关系」卡片选择器共用）：
 * 匹配字段 = title + comment + 产品名 + 内容/投放负责人姓名（卡片只存 id，按目录解析名称），
 * 子串匹配、不区分大小写；排序 = 日期升序 → 列内 orders 升序（自然序，不做相关度排序）。
 */
import type { ContentItem } from '@timeline/core/types'
import { publishDateOf, type Orders } from '@timeline/core/board-view'

export interface CatalogEntry {
  id: string
  name: string
}

/**
 * 按查询串过滤卡片全集（内存过滤，卡片量级几十到几百足够）。
 * 空查询返回空数组；excludeIds 用于选择器排除自身/已关联卡。
 */
export function matchCards(
  query: string,
  items: ContentItem[],
  orders: Orders,
  products: CatalogEntry[],
  members: CatalogEntry[],
  excludeIds?: ReadonlySet<string>,
): ContentItem[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const productName = new Map(products.map((p) => [p.id, p.name.toLowerCase()]))
  const memberName = new Map(members.map((m) => [m.id, m.name.toLowerCase()]))
  return items
    .filter((c) => {
      if (excludeIds?.has(c.id)) return false
      return (
        c.title.toLowerCase().includes(q) ||
        (c.comment ?? '').toLowerCase().includes(q) ||
        (productName.get(c.product_id) ?? '').includes(q) ||
        (memberName.get(c.content_owner_id) ?? '').includes(q) ||
        (memberName.get(c.delivery_owner_id) ?? '').includes(q)
      )
    })
    .sort(
      (a, b) => publishDateOf(a).localeCompare(publishDateOf(b)) || (orders[a.id] ?? 0) - (orders[b.id] ?? 0),
    )
}
