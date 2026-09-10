import { useState } from 'react'
import type { DraggableAttributes } from '@dnd-kit/core'
import type { SyntheticListenerMap } from '@dnd-kit/core/dist/hooks/utilities'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { Contrast, Link2, Palette } from 'lucide-react'
import type { ContentItem } from '@timeline/core/types'
import { BG_COLOR_PRESETS, normalizeBgColor } from '@timeline/core/types'
import { TAGS, UNKNOWN_PRODUCT_CLS, resolveProduct } from '@/lib/content-data'
import { publishDateOf, publishTimeOf, isPublished } from '@timeline/core/board-view'
import { formatCompact, formatRoi } from '@timeline/core/format'

/** 置灰（F2）：整卡 opacity≈0.45 + 去饱和；点亮过渡由卡片根节点的 transition 承担 */
const DIMMED_CLS = 'opacity-[0.45] saturate-50'

/** 搜索/分享定位的一次性高亮（F5/F6 共用）：ring 走 box-shadow，随根节点 transition 淡入淡出 */
const HIGHLIGHT_CLS =
  'ring-2 ring-indigo-400/90 shadow-[0_0_0_5px_rgba(129,140,248,0.20),0_8px_18px_-8px_rgba(15,23,42,0.22)]'

// ---------------------------------------------------------------------------
// CardView：卡片面（单击开详情，不再 inline 编辑），被 SortableCard 与 DragOverlay 复用
// v2-M1b：F1 背景色 = 卡片自有 hex 属性（行内 style --card-bgc + .card-bg 类，token 回退解析）/
//         F2 置灰（opacity 0.45 + 去饱和，工具条 toggle）/
//         F6 工具条「复制分享链接」/ F5+F6 定位一次性高亮（highlighted prop）
// ---------------------------------------------------------------------------
interface CardViewProps {
  card: ContentItem
  onOpenDetail: () => void
  onDelete: () => void
  // v2-M1 卡片动作（仅 interactive 模式的工具条使用；null = 恢复默认背景）
  onSetBgColor?: (hex: string | null) => void
  onToggleDimmed?: () => void
  onCopyShareLink?: () => void
  /** F5/F6 定位高亮：一次性淡入淡出，不循环 */
  highlighted?: boolean
  /** 是否渲染 hover 工具条（默认渲染；DragOverlay 浮动副本等非交互模式天然不渲染） */
  toolbar?: boolean
  // 渲染模式
  placeholder?: boolean // 拖拽中在原位置渲染虚线占位
  overlay?: boolean // DragOverlay 浮动副本
  // sortable 注入
  setNodeRef?: (el: HTMLElement | null) => void
  style?: React.CSSProperties
  attributes?: DraggableAttributes
  listeners?: SyntheticListenerMap
}

const TOOL_BTN =
  'flex h-5 w-5 items-center justify-center rounded-full bg-slate-100 text-slate-400 transition-colors duration-150 hover:bg-indigo-100 hover:text-indigo-600 focus-visible:opacity-100'

function CardView(p: CardViewProps) {
  const tag = TAGS[p.card.type]
  const product = resolveProduct(p.card.product_id)
  const published = isPublished(p.card) // publish_at ≤ now；已发布但指标为 null 的边界显示 —
  const rate = p.card.propagation_4h
    ? Math.min(1, (p.card.engagement_4h ?? 0) / p.card.propagation_4h)
    : 0
  const interactive = !p.overlay && !p.placeholder
  const dimmed = p.card.dimmed === true
  // v2-M1：新增 JSX 读值一律走解构（react-hooks/refs 只命中 p.* 成员链，
  // 本文件 27 个历史告警均为此类；解构写法同 DetailDialog 先例，不新增告警）
  const { card, highlighted: highlightProp, toolbar } = p
  const showToolbar = interactive && toolbar !== false
  const cardId = card.id
  const highlighted = highlightProp === true
  // v2-M1b：bg_color 为 hex 自有属性；存量色板 token 经 normalizeBgColor 回退解析，
  // 非法值（理论上已被加载校验移除）回退默认白底
  const bgHex = card.bg_color ? normalizeBgColor(card.bg_color) : null
  // 行内 style 注入 CSS 变量（Tailwind 静态扫描不受动态值影响；样式见 index.css .card-bg）；
  // 与 sortable 注入的 transform/transition 在 return 前合并（JSX 内新增 p.* 访问会触发 react-hooks/refs）
  const rootStyle: React.CSSProperties = {
    ...(bgHex ? ({ '--card-bgc': bgHex } as React.CSSProperties) : undefined),
    ...p.style,
  }
  // 背景色板展开态（hover 工具条内的小浮层）
  const [bgOpen, setBgOpen] = useState(false)

  return (
    <div
      ref={p.setNodeRef}
      data-card-id={cardId}
      data-card-highlight={highlighted ? 'true' : undefined}
      style={rootStyle}
      {...(p.attributes ?? {})}
      {...(p.listeners ?? {})}
      onClick={interactive ? p.onOpenDetail : undefined}
      className={[
        'group relative rounded-xl border px-3 py-2.5 outline-none select-none',
        // v2-M1：transition 覆盖置灰/点亮的 opacity+filter 与高亮的 box-shadow；
        // prefers-reduced-motion 下直接切换（F2 降级方案，PRD 已定）
        'transition-[transform,box-shadow,background-color,border-color,opacity,filter] duration-150 ease-out motion-reduce:transition-none',
        p.placeholder
          ? 'border-dashed border-indigo-300/80 bg-indigo-50/40 shadow-none'
          : p.overlay
            ? 'rotate-[1.5deg] scale-[1.03] cursor-grabbing border-slate-200 bg-white shadow-[0_18px_36px_-12px_rgba(15,23,42,0.35)]'
            : `cursor-pointer shadow-[0_1px_2px_rgba(15,23,42,0.06)] hover:-translate-y-px hover:shadow-[0_8px_18px_-8px_rgba(15,23,42,0.22)] ${
                bgHex ? 'card-bg' : 'border-slate-200/80 bg-white'
              }`,
        dimmed ? DIMMED_CLS : '',
        highlighted ? HIGHLIGHT_CLS : '',
      ].join(' ')}
    >
      <div className={p.placeholder ? 'invisible' : undefined}>
        {/* hover 工具条：背景色 / 置灰·点亮 / 复制分享链接 / 删除（v2-M1 扩展，删除保持最右；
            v2-M3 关系视图 toolbar=false 不渲染） */}
        {showToolbar && (
          <div
            data-card-toolbar
            className="absolute right-1.5 top-1.5 z-10 flex items-center gap-1 opacity-0 transition-opacity duration-150 focus-within:opacity-100 group-hover:opacity-100"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              data-card-bg-btn
              aria-label="设置背景色"
              title="背景色"
              onClick={(e) => {
                e.stopPropagation()
                setBgOpen((v) => !v)
              }}
              className={TOOL_BTN}
            >
              <Palette className="size-3" />
            </button>
            <button
              type="button"
              data-card-dim-toggle
              aria-label={dimmed ? '点亮卡片' : '置灰卡片'}
              title={dimmed ? '点亮' : '置灰'}
              onClick={(e) => {
                e.stopPropagation()
                p.onToggleDimmed?.()
              }}
              className={`${TOOL_BTN} ${dimmed ? 'bg-indigo-100 text-indigo-500' : ''}`}
            >
              <Contrast className="size-3" />
            </button>
            <button
              type="button"
              data-card-copy-link
              aria-label="复制分享链接"
              title="复制分享链接"
              onClick={(e) => {
                e.stopPropagation()
                p.onCopyShareLink?.()
              }}
              className={TOOL_BTN}
            >
              <Link2 className="size-3" />
            </button>
            <button
              type="button"
              aria-label="删除卡片"
              onClick={(e) => {
                e.stopPropagation()
                p.onDelete()
              }}
              className={`${TOOL_BTN} text-[13px] leading-none hover:bg-rose-100 hover:text-rose-600`}
            >
              ×
            </button>

            {/* 背景色板浮层：8 预设（写入对应 hex）+ 默认（移除字段）；点击外部/再次点按钮收起 */}
            {bgOpen && (
              <>
                <div
                  className="fixed inset-0 z-20 cursor-default"
                  onPointerDown={(e) => {
                    e.stopPropagation()
                    setBgOpen(false)
                  }}
                  onClick={(e) => e.stopPropagation()}
                />
                <div
                  data-bg-palette
                  className="absolute right-0 top-6 z-30 flex items-center gap-1.5 rounded-full border border-slate-200/80 bg-white/95 px-2 py-1.5 shadow-[0_10px_24px_-10px_rgba(15,23,42,0.35)] backdrop-blur"
                >
                  <button
                    type="button"
                    data-bg-swatch="default"
                    title="默认（无背景色）"
                    aria-label="默认背景"
                    onClick={(e) => {
                      e.stopPropagation()
                      p.onSetBgColor?.(null)
                      setBgOpen(false)
                    }}
                    className={`flex h-4 w-4 items-center justify-center rounded-full border border-slate-300 bg-white text-[9px] leading-none text-slate-400 ${
                      !bgHex ? 'ring-2 ring-indigo-400/80' : ''
                    }`}
                  >
                    ×
                  </button>
                  {BG_COLOR_PRESETS.map((preset) => (
                    <button
                      key={preset.token}
                      type="button"
                      data-bg-swatch={preset.token}
                      title={preset.label}
                      aria-label={`背景色 ${preset.label}`}
                      onClick={(e) => {
                        e.stopPropagation()
                        p.onSetBgColor?.(preset.hex)
                        setBgOpen(false)
                      }}
                      style={{ backgroundColor: preset.hex }}
                      className={`h-4 w-4 rounded-full ${
                        bgHex === preset.hex ? 'ring-2 ring-indigo-400/80 ring-offset-1' : ''
                      }`}
                    />
                  ))}
                </div>
              </>
            )}
          </div>
        )}

        {/* 顶部行：类型胶囊 + 状态点（hover 时让位给工具条） */}
        <div className="flex items-center justify-between">
          <span
            data-card-type
            className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] ${tag.pill}`}
          >
            <span className={`h-1.5 w-1.5 rounded-full ${tag.dot}`} />
            {tag.label}
          </span>
          <span
            title={p.card.status ?? (published ? '已发布' : '待发布')}
            className={`h-1.5 w-1.5 rounded-full transition-opacity duration-150 group-hover:opacity-0 ${
              published ? 'bg-emerald-500' : 'bg-slate-300'
            }`}
          />
        </div>

        {/* 标题（第一张 p，e2e 钩子 data-card-title） */}
        <p
          data-card-title
          className={`mt-1.5 line-clamp-2 pr-5 text-sm font-semibold leading-snug ${
            p.card.title ? 'text-slate-800' : 'text-slate-300'
          }`}
        >
          {p.card.title || '未命名卡片'}
        </p>

        {/* comment 单行预览，为空不渲染 */}
        {p.card.comment && (
          <p className="mt-0.5 line-clamp-1 text-xs text-slate-400">{p.card.comment}</p>
        )}

        {/* 指标区：已发布 = 3 列迷你统计格 + 互动率细条；待执行/待发布 = 虚线占位（显示实际状态） */}
        {published ? (
          <>
            <div className="mt-2 grid grid-cols-3 divide-x divide-slate-100 rounded-lg bg-slate-50/80 py-1.5">
              <div className="px-1 text-center">
                <p className="text-[10px] leading-tight text-slate-400">ROI</p>
                <p className="mt-px text-[13px] font-semibold tabular-nums text-slate-700">
                  {p.card.roi === null ? '—' : formatRoi(p.card.roi)}
                </p>
              </div>
              <div className="px-1 text-center">
                <p className="text-[10px] leading-tight text-slate-400">曝光·4h</p>
                <p className="mt-px text-[13px] font-semibold tabular-nums text-slate-700">
                  {p.card.propagation_4h === null ? '—' : formatCompact(p.card.propagation_4h)}
                </p>
              </div>
              <div className="px-1 text-center">
                <p className="text-[10px] leading-tight text-slate-400">互动·4h</p>
                <p className="mt-px text-[13px] font-semibold tabular-nums text-slate-700">
                  {p.card.engagement_4h === null ? '—' : formatCompact(p.card.engagement_4h)}
                </p>
              </div>
            </div>
            {/* 互动率细进度条：一眼看出内容质量 */}
            <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-slate-100">
              <div
                className="h-full rounded-full bg-gradient-to-r from-indigo-400 to-violet-500"
                style={{ width: `${Math.round(rate * 100)}%` }}
              />
            </div>
          </>
        ) : (
          <div className="mt-2 rounded-lg border border-dashed border-slate-200 py-2 text-center text-[11px] text-slate-300">
            {p.card.status ?? '待发布'}
          </div>
        )}

        {/* 底行：publish_at 时分胶囊 + 产品名 */}
        <div className="mt-2 flex items-center justify-between gap-2">
          <span className="shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium tabular-nums text-slate-500">
            {publishTimeOf(p.card)}
          </span>
          <span
            data-card-product
            title={product.unknown && product.rawId ? `原始 product_id: ${product.rawId}` : undefined}
            className={`truncate text-[11px] ${product.unknown ? UNKNOWN_PRODUCT_CLS : 'text-slate-400'}`}
          >
            {product.name}
          </span>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// SortableCard：挂载 useSortable
// v2-M3：CardView 导出复用（关系图节点 = 同款完整卡片面，不挂 sortable）
// ---------------------------------------------------------------------------
export { CardView }
interface SortableCardProps {
  card: ContentItem
  onOpenDetail: (id: string) => void
  onDelete: (id: string) => void
  /** v2-M1：卡片动作（背景色写 hex；null = 恢复默认） */
  onSetBgColor: (id: string, hex: string | null) => void
  onToggleDimmed: (id: string) => void
  onCopyShareLink: (id: string) => void
  /** F5/F6 定位一次性高亮 */
  highlighted?: boolean
  /**
   * v2-M2：列归属 key 覆盖（custom 分组模式传入 group_id / '' 未分组）。
   * 缺省 = publishDateOf(card)（date 模式）；碰撞判定按 data.date 同列过滤，
   * 两种模式复用同一字段（见 Board.tsx 组合式碰撞判定注释）。
   */
  colKey?: string
}

export default function SortableCard({
  card,
  onOpenDetail,
  onDelete,
  onSetBgColor,
  onToggleDimmed,
  onCopyShareLink,
  highlighted,
  colKey,
}: SortableCardProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: card.id,
    data: { type: 'card', date: colKey ?? publishDateOf(card) },
  })

  return (
    <CardView
      card={card}
      onOpenDetail={() => onOpenDetail(card.id)}
      onDelete={() => onDelete(card.id)}
      onSetBgColor={(color) => onSetBgColor(card.id, color)}
      onToggleDimmed={() => onToggleDimmed(card.id)}
      onCopyShareLink={() => onCopyShareLink(card.id)}
      highlighted={highlighted}
      placeholder={isDragging}
      setNodeRef={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      attributes={attributes}
      listeners={listeners}
    />
  )
}

// DragOverlay 用的静态副本
export function OverlayCard({ card }: { card: ContentItem }) {
  const noop = () => undefined
  return <CardView card={card} onOpenDetail={noop} onDelete={noop} overlay />
}
