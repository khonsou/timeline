import type { DraggableAttributes } from '@dnd-kit/core'
import type { SyntheticListenerMap } from '@dnd-kit/core/dist/hooks/utilities'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import type { ContentItem } from '@/types/content'
import { PRODUCT_BY_ID, TAGS } from '@/lib/content-data'
import { publishDateOf, publishTimeOf } from '@/lib/board-view'
import { formatCompact, formatRoi } from '@/lib/format'

// ---------------------------------------------------------------------------
// CardView：卡片面（单击开详情，不再 inline 编辑），被 SortableCard 与 DragOverlay 复用
// ---------------------------------------------------------------------------
interface CardViewProps {
  card: ContentItem
  onOpenDetail: () => void
  onDelete: () => void
  // 渲染模式
  placeholder?: boolean // 拖拽中在原位置渲染虚线占位
  overlay?: boolean // DragOverlay 浮动副本
  // sortable 注入
  setNodeRef?: (el: HTMLElement | null) => void
  style?: React.CSSProperties
  attributes?: DraggableAttributes
  listeners?: SyntheticListenerMap
}

function CardView(p: CardViewProps) {
  const tag = TAGS[p.card.type]
  const product = PRODUCT_BY_ID[p.card.product_id]
  const published = p.card.roi !== null // 未发布 ⇒ 三个指标一律 null
  const rate = p.card.propagation_4h
    ? Math.min(1, (p.card.engagement_4h ?? 0) / p.card.propagation_4h)
    : 0
  const interactive = !p.overlay && !p.placeholder

  return (
    <div
      ref={p.setNodeRef}
      style={p.style}
      {...(p.attributes ?? {})}
      {...(p.listeners ?? {})}
      onClick={interactive ? p.onOpenDetail : undefined}
      className={[
        'group relative rounded-xl border px-3 py-2.5 outline-none select-none',
        'transition-[transform,box-shadow,background-color,border-color] duration-150 ease-out',
        p.placeholder
          ? 'border-dashed border-indigo-300/80 bg-indigo-50/40 shadow-none'
          : p.overlay
            ? 'rotate-[1.5deg] scale-[1.03] cursor-grabbing border-slate-200 bg-white shadow-[0_18px_36px_-12px_rgba(15,23,42,0.35)]'
            : 'cursor-pointer border-slate-200/80 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.06)] hover:-translate-y-px hover:shadow-[0_8px_18px_-8px_rgba(15,23,42,0.22)]',
      ].join(' ')}
    >
      <div className={p.placeholder ? 'invisible' : undefined}>
        {/* 删除按钮：hover 淡入，始终可点 */}
        {interactive && (
          <button
            type="button"
            aria-label="删除卡片"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation()
              p.onDelete()
            }}
            className="absolute right-1.5 top-1.5 z-10 flex h-5 w-5 items-center justify-center rounded-full bg-slate-100 text-[13px] leading-none text-slate-400 opacity-0 transition-opacity duration-150 hover:bg-rose-100 hover:text-rose-600 focus-visible:opacity-100 group-hover:opacity-100"
          >
            ×
          </button>
        )}

        {/* 顶部行：类型胶囊 + 状态点（hover 时让位给删除按钮） */}
        <div className="flex items-center justify-between">
          <span
            className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] ${tag.pill}`}
          >
            <span className={`h-1.5 w-1.5 rounded-full ${tag.dot}`} />
            {tag.label}
          </span>
          <span
            title={published ? '已发布' : '待发布'}
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

        {/* 指标区：已发布 = 3 列迷你统计格 + 互动率细条；待发布 = 虚线占位 */}
        {published ? (
          <>
            <div className="mt-2 grid grid-cols-3 divide-x divide-slate-100 rounded-lg bg-slate-50/80 py-1.5">
              <div className="px-1 text-center">
                <p className="text-[10px] leading-tight text-slate-400">ROI</p>
                <p className="mt-px text-[13px] font-semibold tabular-nums text-slate-700">
                  {formatRoi(p.card.roi!)}
                </p>
              </div>
              <div className="px-1 text-center">
                <p className="text-[10px] leading-tight text-slate-400">曝光·4h</p>
                <p className="mt-px text-[13px] font-semibold tabular-nums text-slate-700">
                  {formatCompact(p.card.propagation_4h ?? 0)}
                </p>
              </div>
              <div className="px-1 text-center">
                <p className="text-[10px] leading-tight text-slate-400">互动·4h</p>
                <p className="mt-px text-[13px] font-semibold tabular-nums text-slate-700">
                  {formatCompact(p.card.engagement_4h ?? 0)}
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
            待发布
          </div>
        )}

        {/* 底行：publish_at 时分胶囊 + 产品名 */}
        <div className="mt-2 flex items-center justify-between gap-2">
          <span className="shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium tabular-nums text-slate-500">
            {publishTimeOf(p.card)}
          </span>
          <span className="truncate text-[11px] text-slate-400">
            {product?.name ?? p.card.product_id}
          </span>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// SortableCard：挂载 useSortable
// ---------------------------------------------------------------------------
interface SortableCardProps {
  card: ContentItem
  onOpenDetail: (id: string) => void
  onDelete: (id: string) => void
}

export default function SortableCard({ card, onOpenDetail, onDelete }: SortableCardProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: card.id,
    data: { type: 'card', date: publishDateOf(card) },
  })

  return (
    <CardView
      card={card}
      onOpenDetail={() => onOpenDetail(card.id)}
      onDelete={() => onDelete(card.id)}
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
