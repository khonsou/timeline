import type { ContentItem, ContentType } from '@/types/content'
import type { Orders } from './board-view'
import { publishDateOf } from './board-view'

// ---------------------------------------------------------------------------
// 日期轴范围：今天 ±14 天，共 29 个日列
// ---------------------------------------------------------------------------
export const RANGE_DAYS = 14
export const DAY_COUNT = RANGE_DAYS * 2 + 1

export interface DayInfo {
  date: string // "YYYY-MM-DD"
  monthDay: string // "M/D"
  week: string // "周X"
  isToday: boolean
  isWeekend: boolean
}

// ---------------------------------------------------------------------------
// 标签配置：5 类内容类型（圆点色 + 胶囊浅色）
// ---------------------------------------------------------------------------
export const TAGS: Record<ContentType, { label: ContentType; dot: string; pill: string }> = {
  图文: { label: '图文', dot: 'bg-sky-500', pill: 'bg-sky-50 text-sky-700' },
  视频: { label: '视频', dot: 'bg-rose-500', pill: 'bg-rose-50 text-rose-700' },
  音频: { label: '音频', dot: 'bg-amber-500', pill: 'bg-amber-50 text-amber-700' },
  直播: { label: '直播', dot: 'bg-violet-500', pill: 'bg-violet-50 text-violet-700' },
  数据: { label: '数据', dot: 'bg-emerald-500', pill: 'bg-emerald-50 text-emerald-700' },
}
export const TYPE_KEYS = Object.keys(TAGS) as ContentType[]

// ---------------------------------------------------------------------------
// 产品目录（数据层常量），ContentItem.product_id 引用之
// P-1000 是看板自身（首次启动引导卡归属）
// ---------------------------------------------------------------------------
export interface Product {
  id: string
  name: string
}
export const PRODUCTS: Product[] = [
  { id: 'P-1000', name: '拾光轴 Timeline Board' },
  { id: 'P-1001', name: '星轨机械键盘' },
  { id: 'P-1002', name: '流光蓝牙耳机' },
  { id: 'P-1003', name: '云屿香薰机' },
  { id: 'P-1004', name: '极昼护眼台灯' },
  { id: 'P-1005', name: '脉冲快充数据线' },
  { id: 'P-1006', name: '拾光手账本' },
]
export const PRODUCT_BY_ID: Record<string, Product> = Object.fromEntries(
  PRODUCTS.map((p) => [p.id, p]),
)

// 运行时产品目录：board.json 携带 products 时优先于内置目录；未知 id 降级显示 id 本身
let runtimeProducts: Record<string, Product> | null = null
export function setRuntimeProducts(products?: Product[]) {
  runtimeProducts =
    products && products.length > 0
      ? Object.fromEntries(products.map((p) => [p.id, p]))
      : null
}
export function resolveProduct(id: string): Product {
  return runtimeProducts?.[id] ?? PRODUCT_BY_ID[id] ?? { id, name: id }
}

/** 当前生效的产品目录：内置 PRODUCTS + 运行时（seed products 优先覆盖）去重合并 */
export function listProducts(): Product[] {
  const map = new Map(PRODUCTS.map((p) => [p.id, p]))
  if (runtimeProducts) {
    for (const p of Object.values(runtimeProducts)) map.set(p.id, p)
  }
  return [...map.values()]
}

// ---------------------------------------------------------------------------
// 日期工具
// ---------------------------------------------------------------------------
export const pad2 = (n: number) => String(n).padStart(2, '0')

export function fmtDate(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}
export const todayStr = () => fmtDate(new Date())

const WEEK_LABELS = ['日', '一', '二', '三', '四', '五', '六']

const DAY_MS = 24 * 60 * 60 * 1000
const dayStart = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate())
const parseDay = (date: string) => {
  const [y, m, d] = date.split('-').map(Number)
  return new Date(y, m - 1, d)
}

/**
 * 生成日列窗口：默认今天 ±14 天；
 * 传入 items 时窗口由数据驱动——扩到 max(今天±14, 数据最早/最晚日期)，
 * 保证窗口外（历史/未来）数据也有列可归。
 */
export function buildDays(items?: ContentItem[]): DayInfo[] {
  const today = dayStart(new Date())
  let start = new Date(today.getTime() - RANGE_DAYS * DAY_MS)
  let end = new Date(today.getTime() + RANGE_DAYS * DAY_MS)
  if (items) {
    for (const it of items) {
      const d = parseDay(publishDateOf(it))
      if (d.getTime() < start.getTime()) start = d
      if (d.getTime() > end.getTime()) end = d
    }
  }
  const count = Math.round((end.getTime() - start.getTime()) / DAY_MS) + 1
  const todayKey = fmtDate(today)
  return Array.from({ length: count }, (_, i) => {
    const d = new Date(start.getTime() + i * DAY_MS)
    const wd = d.getDay()
    return {
      date: fmtDate(d),
      monthDay: `${d.getMonth() + 1}/${d.getDate()}`,
      week: `周${WEEK_LABELS[wd]}`,
      isToday: fmtDate(d) === todayKey,
      isWeekend: wd === 0 || wd === 6,
    }
  })
}

export const uid = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `id-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`

// ---------------------------------------------------------------------------
// 首次启动引导卡：今天 23:00 / 23:59（待发布、无指标，卡面保持干净），
// 归属看板自身产品 P-1000。仅在 localStorage 无 key 或数据损坏时播种；
// 用户删光卡片是合法状态（空 items 照样通过校验），刷新不会复活引导卡。
// ---------------------------------------------------------------------------
export function guideCards(): { items: ContentItem[]; orders: Orders } {
  const today = todayStr()
  const mk = (title: string, type: ContentType, time: string, comment: string): ContentItem => ({
    id: uid(),
    title,
    type,
    publish_at: `${today}T${time}`,
    roi: null,
    comment,
    product_id: 'P-1000',
    propagation_4h: null,
    engagement_4h: null,
  })
  const items = [
    mk(
      '欢迎使用拾光轴 · 5 分钟上手',
      '图文',
      '23:00',
      '· 单击卡片打开详情：标题、备注、类型、计划发布时间、归属产品、ROI、曝光、互动都可点击编辑\n' +
        '· 拖拽卡片到其他日期即可调整计划发布时间；同列上下拖动调整顺序\n' +
        '· 卡片右上角 × 删除；每列底部「+ 空卡片」新增\n' +
        '· 横向滚动查看前后日期，滚远了点右下角「回到今天」',
    ),
    mk(
      'CLI 批量导入真实数据',
      '数据',
      '23:59',
      '· 命令：npm run import:data -- 你的数据.csv（或 .json）\n' +
        '· --dry-run 先校验不写文件 · --merge 合并已有数据 · --strict 遇错即停\n' +
        '· 支持中文字段名表头；id 可留空（按内容哈希自动生成）\n' +
        '· 导入后刷新页面自动生效；字段口径见 src/types/content.ts\n' +
        '· 示例文件：examples/import-sample.json / import-sample.csv\n' +
        '· 完整指南：docs/cli-import-guide.md（可直接粘贴到飞书文档）',
    ),
  ]
  return { items, orders: { [items[0].id]: 0, [items[1].id]: 1 } }
}
