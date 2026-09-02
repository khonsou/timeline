import { useEffect, useState } from 'react'
import type { DraggableAttributes } from '@dnd-kit/core'
import type { SyntheticListenerMap } from '@dnd-kit/core/dist/hooks/utilities'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import type { ContentItem } from '@/types/content'
import { PRODUCT_BY_ID, TAGS } from '@/lib/content-data'
import { publishDateOf, publishTimeOf } from '@/lib/board-view'
import { formatCompact, formatRoi } from '@/lib/format'

// ---------------------------------------------------------------------------
// CardView：纯展示 + 标题 inline 编辑，被 SortableCard 与 DragOverlay 复用
// ---------------------------------------------------------------------------
interface CardViewProps {
  card: ContentItem
  editingTitle: boolean
  draftTitle: string
  setDraftTitle: (v: string) => void
  startTitleEdit: () => void
  commitTitle: () => void
  cancelTitle: () => void
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
  const interactive = !p.overlay && !p.placeholder

  return (
    <div
      ref={p.setNodeRef}
      style={p.style}
      {...(p.attributes ?? {})}
      {...(p.listeners ?? {})}
      className={[
        'group relative rounded-xl border px-3 py-2.5 outline-none select-none',
        'transition-[transform,box-shadow,background-color,border-color] duration-150 ease-out',
        p.placeholder
          ? 'border-dashed border-indigo-300/80 bg-indigo-50/40 shadow-none'
          : p.overlay
            ? 'rotate-[1.5deg] scale-[1.03] cursor-grabbing border-slate-200 bg-white shadow-[0_18px_36px_-12px_rgba(15,23,42,0.35)]'
            : 'cursor-grab border-slate-200/80 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.06)] hover:-translate-y-px hover:shadow-[0_8px_18px_-8px_rgba(15,23,42,0.22)]',
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

        {/* 标题：单击进入 inline 编辑 */}
        {p.editingTitle ? (
          <input
            autoFocus
            value={p.draftTitle}
            onChange={(e) => p.setDraftTitle(e.target.value)}
            onFocus={(e) => e.currentTarget.select()}
            onBlur={p.commitTitle}
            onKeyDown={(e) => {
              if (e.key === 'Enter') p.commitTitle()
              if (e.key === 'Escape') p.cancelTitle()
            }}
            onPointerDown={(e) => e.stopPropagation()}
            placeholder="输入卡片标题…"
            className="w-full rounded-md border border-indigo-300 bg-white px-1.5 py-1 text-sm font-medium leading-snug text-slate-800 focus:outline-none focus:ring-2 focus:ring-indigo-200"
          />
        ) : (
          <p
            onClick={interactive ? p.startTitleEdit : undefined}
            title={interactive ? '点击编辑标题' : undefined}
            className={`pr-5 text-sm font-medium leading-snug ${
              p.card.title ? 'text-slate-800' : 'text-slate-300'
            } ${interactive ? 'cursor-text' : ''}`}
          >
            {p.card.title || '未命名卡片'}
          </p>
        )}

        {/* comment 复盘小字预览，为空不渲染 */}
        {p.card.comment && (
          <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-slate-400">
            {p.card.comment}
          </p>
        )}

        {/* 指标行：已发布展示 产品 · ROI · 曝光 · 互动；未发布展示待发布态 */}
        {published ? (
          <p className="mt-1.5 truncate text-[11px] tabular-nums text-slate-400">
            {product?.name ?? p.card.product_id} · ROI {formatRoi(p.card.roi!)} · 曝光{' '}
            {formatCompact(p.card.propagation_4h ?? 0)} · 互动{' '}
            {formatCompact(p.card.engagement_4h ?? 0)}
          </p>
        ) : (
          <p className="mt-1.5 truncate text-[11px] text-slate-300">
            待发布 · {product?.name ?? p.card.product_id}
          </p>
        )}

        {/* 底行：publish_at 时分胶囊（仅展示） + 类型彩色胶囊 */}
        <div className="mt-2 flex items-center justify-between gap-2">
          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium tabular-nums text-slate-500">
            {publishTimeOf(p.card)}
          </span>
          <span
            className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] ${tag.pill}`}
          >
            <span className={`h-1.5 w-1.5 rounded-full ${tag.dot}`} />
            {tag.label}
          </span>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// SortableCard：挂载 useSortable；编辑态禁用拖拽
// ---------------------------------------------------------------------------
interface SortableCardProps {
  card: ContentItem
  autoEditTitle: boolean
  onEditEnd: () => void
  onUpdate: (id: string, patch: Partial<ContentItem>) => void
  onDelete: (id: string) => void
}

export default function SortableCard({
  card,
  autoEditTitle,
  onEditEnd,
  onUpdate,
  onDelete,
}: SortableCardProps) {
  const [editingTitle, setEditingTitle] = useState(false)
  const [draftTitle, setDraftTitle] = useState(card.title)

  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: card.id,
    data: { type: 'card', date: publishDateOf(card) },
    disabled: editingTitle,
  })

  // 新增空卡片后立即进入标题编辑态
  useEffect(() => {
    if (autoEditTitle) {
      setDraftTitle(card.title)
      setEditingTitle(true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoEditTitle])

  const startTitleEdit = () => {
    setDraftTitle(card.title)
    setEditingTitle(true)
  }
  const commitTitle = () => {
    const t = draftTitle.trim()
    if (t && t !== card.title) onUpdate(card.id, { title: t })
    setEditingTitle(false)
    onEditEnd()
  }
  const cancelTitle = () => {
    setDraftTitle(card.title)
    setEditingTitle(false)
    onEditEnd()
  }

  return (
    <CardView
      card={card}
      editingTitle={editingTitle}
      draftTitle={draftTitle}
      setDraftTitle={setDraftTitle}
      startTitleEdit={startTitleEdit}
      commitTitle={commitTitle}
      cancelTitle={cancelTitle}
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
  return (
    <CardView
      card={card}
      editingTitle={false}
      draftTitle={card.title}
      setDraftTitle={noop}
      startTitleEdit={noop}
      commitTitle={noop}
      cancelTitle={noop}
      onDelete={noop}
      overlay
    />
  )
}
