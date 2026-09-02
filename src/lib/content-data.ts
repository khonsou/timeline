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
// ---------------------------------------------------------------------------
export interface Product {
  id: string
  name: string
}
export const PRODUCTS: Product[] = [
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
// Dummy data：45~70 条，publish_at 以今天为中心 ±14 天加权，时分随机 07:00–22:59
// ---------------------------------------------------------------------------
export const TITLE_POOL: string[] = [
  '晨间资讯速览', '短视频脚本 v2', '直播预告海报', '播客第 12 期剪辑', '数据日报 · 复盘',
  '公众号头条排版', '封面图终稿确认', '评论区置顶回复', '选题脑暴会纪要', '下周排期表',
  '热点追踪清单', '品牌合作 brief', '小红书种草笔记', 'B 站字幕校对', '抖音挑战赛方案',
  '社群早安海报', '周报数据看板', '用户访谈整理', '竞品动态扫描', '头条开屏文案',
  '会员日活动预热', '直播间话术卡', '音频片头重录', '长图文拆条', '私域朋友圈文案',
  '视频号连麦彩排', '稿件终审与签发', '素材库归档', '弹幕互动话题', '季度 OKR 对齐',
  '推送 A/B 测试', '海报三连图', '片尾彩蛋剪辑', '金句卡片九宫格', '行业早报速递',
  '直播复盘数据包', '跨平台分发清单',
]

const COMMENT_POOL: string[] = [
  '封面点击率偏低，下期换主图',
  'ROI 达标，可追加预算',
  '评论区争议较多，需跟进',
  '曝光超预期，复盘投放时段',
  '互动率高但转化一般，优化落地页',
  '标题前 8 字决定点击，已迭代',
  '直播中掉线 2 分钟，影响留存',
  '数据口径与运营对齐后再发',
  '素材复用率高，成本可控',
  'KOL 联动效果好，下月加场',
  '结尾 CTA 不明显，改版重发',
  '收藏率高于均值，做系列化',
  '发布时段偏晚，下次提前到 19 点',
  '评论区高频问题整理成 FAQ',
  '投流 ROI 偏低，暂停加预算',
]

// 近似正态的日期偏移采样：均值 0，±7 天内密度高
function sampleDayOffset(): number {
  const g = (Math.random() + Math.random() + Math.random() - 1.5) / 1.5 // [-1, 1]，中心加权
  return Math.max(-RANGE_DAYS, Math.min(RANGE_DAYS, Math.round(g * RANGE_DAYS)))
}

function dateByOffset(offset: number): string {
  const d = new Date()
  d.setDate(d.getDate() + offset)
  return fmtDate(d)
}

/** 对数分布取整：1k ~ 200k */
function samplePropagation(): number {
  const v = Math.exp(Math.log(1000) + Math.random() * (Math.log(200000) - Math.log(1000)))
  return Math.round(v)
}

export interface GeneratedData {
  items: ContentItem[]
  orders: Orders
}

export function generateContent(): GeneratedData {
  const count = 45 + Math.floor(Math.random() * 26) // 45~70 条
  const now = new Date()
  const nowKey = `${fmtDate(now)}T${pad2(now.getHours())}:${pad2(now.getMinutes())}`
  const perDay = new Map<string, number>()
  const items: ContentItem[] = []

  for (let i = 0; i < count; i++) {
    let date = dateByOffset(sampleDayOffset())
    let tries = 0
    while ((perDay.get(date) ?? 0) >= 6 && tries < 40) {
      date = dateByOffset(sampleDayOffset())
      tries++
    }
    if ((perDay.get(date) ?? 0) >= 6) continue
    perDay.set(date, (perDay.get(date) ?? 0) + 1)

    const time = `${pad2(7 + Math.floor(Math.random() * 16))}:${pad2(Math.floor(Math.random() * 60))}`
    const publish_at = `${date}T${time}`
    const published = publish_at <= nowKey // 已发布必须有数，未来一律 null

    const propagation = published ? samplePropagation() : null
    items.push({
      id: uid(),
      title: TITLE_POOL[Math.floor(Math.random() * TITLE_POOL.length)],
      type: TYPE_KEYS[Math.floor(Math.random() * TYPE_KEYS.length)],
      publish_at,
      roi: published ? Math.round((0.4 + Math.random() * 5.6) * 10) / 10 : null,
      comment: Math.random() < 0.6 ? COMMENT_POOL[Math.floor(Math.random() * COMMENT_POOL.length)] : '',
      product_id: PRODUCTS[Math.floor(Math.random() * PRODUCTS.length)].id,
      propagation_4h: propagation,
      engagement_4h:
        published && propagation !== null
          ? Math.round(propagation * (0.03 + Math.random() * 0.12))
          : null,
    })
  }

  // 视图层初始顺序：按天 0,1,2…
  const counter = new Map<string, number>()
  const orders: Orders = {}
  for (const item of items) {
    const date = publishDateOf(item)
    const n = counter.get(date) ?? 0
    counter.set(date, n + 1)
    orders[item.id] = n
  }

  return { items, orders }
}
