import type { ContentItem, ContentType, Member } from '@/types/content'
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
// 内置目录仅 P-1000 光轴（看板自身，首次启动引导卡归属）；
// 真实产品通过 CLI --products / 应用内「产品管理」/ items 内嵌 products 进入运行时目录
// ---------------------------------------------------------------------------
export interface Product {
  id: string
  name: string
}
export const PRODUCTS: Product[] = [{ id: 'P-1000', name: '光轴' }]
export const PRODUCT_BY_ID: Record<string, Product> = Object.fromEntries(
  PRODUCTS.map((p) => [p.id, p]),
)

// 运行时产品目录 = App 的一等产品状态（localStorage 持久化；初始 = 内置目录）。
// App 的任何产品变更（产品管理增删改 / CLI 导入接管 / UI 导入内嵌 products）都经
// setRuntimeProducts 同步到这里；空 id / 目录未命中 → 「不明」（rawId 供 tooltip 排查）
let runtimeProducts: Record<string, Product> = { ...PRODUCT_BY_ID }
export function setRuntimeProducts(products?: Product[]) {
  // undefined → 回落内置目录；[]（空目录）是合法状态（用户删光产品），原样生效
  runtimeProducts =
    products === undefined
      ? { ...PRODUCT_BY_ID }
      : Object.fromEntries(products.map((p) => [p.id, p]))
}

export const UNKNOWN_PRODUCT_LABEL = '不明'
/** 「不明」共用视觉：淡色 + 极轻虚线下划线，与正常产品名区分但不刺眼 */
export const UNKNOWN_PRODUCT_CLS =
  'text-slate-300 underline decoration-dotted decoration-slate-300/80 underline-offset-2'

export interface ResolvedProduct extends Product {
  /** true = 未归属（空 id）或目录未命中；此时 name 固定为「不明」 */
  unknown: boolean
  /** 原始 product_id（unknown 且非空时用于 tooltip 排查；命中时等同 id） */
  rawId: string
}

/**
 * 归属产品解析（卡片面与详情页共用）：只读运行时产品目录（= App 产品状态，
 * 初始为内置目录 P-1000 光轴）→ 空 id / 未命中 → 「不明」。
 * 保证任何 product_id 取值下显示都不出 bug。
 */
export function resolveProduct(id: string): ResolvedProduct {
  const raw = String(id ?? '').trim()
  const hit = runtimeProducts[raw]
  if (hit) return { ...hit, unknown: false, rawId: raw }
  return { id: raw, name: UNKNOWN_PRODUCT_LABEL, unknown: true, rawId: raw }
}

/** 当前生效的产品目录（= 运行时状态，选择器选项顺序即状态数组顺序） */
export function listProducts(): Product[] {
  return Object.values(runtimeProducts)
}

// ---------------------------------------------------------------------------
// 成员目录（与产品目录完全同构）：ContentItem.content_owner_id / delivery_owner_id 引用之。
// 内置种子仅 2 个示例成员；真实成员通过 CLI 导入自动登记 / 应用内「成员管理」进入运行时目录
// ---------------------------------------------------------------------------
export const MEMBERS: Member[] = [
  { id: 'M-1001', name: '林晓' },
  { id: 'M-1002', name: '陈远' },
]
export const MEMBER_BY_ID: Record<string, Member> = Object.fromEntries(
  MEMBERS.map((m) => [m.id, m]),
)

// 运行时成员目录 = App 的一等成员状态（localStorage 持久化；初始 = 内置种子）。
// App 的任何成员变更（成员管理增删改 / CLI 导入接管 / UI 导入 memberHints）都经
// setRuntimeMembers 同步到这里；空 id / 目录未命中 → 「未分配」（rawId 供 tooltip 排查）
let runtimeMembers: Record<string, Member> = { ...MEMBER_BY_ID }
export function setRuntimeMembers(members?: Member[]) {
  // undefined → 回落内置种子；[]（空目录）是合法状态（用户删光成员），原样生效
  runtimeMembers =
    members === undefined
      ? { ...MEMBER_BY_ID }
      : Object.fromEntries(members.map((m) => [m.id, m]))
}

export const UNASSIGNED_MEMBER_LABEL = '未分配'

export interface ResolvedMember extends Member {
  /** true = 未分配（空 id）或目录未命中；此时 name 固定为「未分配」 */
  unassigned: boolean
  /** 原始 owner id（unassigned 且非空时用于 tooltip 排查；命中时等同 id） */
  rawId: string
}

/** 负责人解析（详情页共用）：只读运行时成员目录 → 空 id / 未命中 → 「未分配」 */
export function resolveMember(id: string): ResolvedMember {
  const raw = String(id ?? '').trim()
  const hit = runtimeMembers[raw]
  if (hit) return { ...hit, unassigned: false, rawId: raw }
  return { id: raw, name: UNASSIGNED_MEMBER_LABEL, unassigned: true, rawId: raw }
}

/** 当前生效的成员目录（= 运行时状态，选择器选项顺序即状态数组顺序） */
export function listMembers(): Member[] {
  return Object.values(runtimeMembers)
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
    status: '待发布',
    content_owner_id: '',
    delivery_owner_id: '',
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
