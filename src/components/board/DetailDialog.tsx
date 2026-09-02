import { useEffect, useRef, useState } from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { XIcon } from 'lucide-react'
import { Dialog, DialogOverlay, DialogPortal, DialogTitle } from '@/components/ui/dialog'
import type { ContentItem } from '@/types/content'
import { PRODUCT_BY_ID, TAGS } from '@/lib/content-data'
import { formatCompact, formatPublishAt, formatRoi } from '@/lib/format'

interface DetailDialogProps {
  card: ContentItem | null // null = 关闭
  autoEditTitle: boolean // 新增空卡片后标题直接进入编辑态
  onClose: () => void
  onUpdate: (id: string, patch: Partial<ContentItem>) => void
  onDelete: (id: string) => void
}

export default function DetailDialog({
  card,
  autoEditTitle,
  onClose,
  onUpdate,
  onDelete,
}: DetailDialogProps) {
  const [editingTitle, setEditingTitle] = useState(false)
  const [draftTitle, setDraftTitle] = useState('')
  const [editingComment, setEditingComment] = useState(false)
  const [draftComment, setDraftComment] = useState('')
  const titleInputRef = useRef<HTMLInputElement>(null)

  // 打开另一张卡时重置编辑态；新增空卡片直接标题编辑
  const cardId = card?.id
  useEffect(() => {
    setEditingComment(false)
    if (cardId && autoEditTitle) {
      setDraftTitle('')
      setEditingTitle(true)
    } else {
      setEditingTitle(false)
    }
  }, [cardId, autoEditTitle])

  useEffect(() => {
    if (editingTitle) {
      titleInputRef.current?.focus()
      titleInputRef.current?.select()
    }
  }, [editingTitle])

  const published = card ? card.roi !== null : false
  const product = card ? PRODUCT_BY_ID[card.product_id] : undefined
  const rate =
    card && card.propagation_4h ? Math.min(1, (card.engagement_4h ?? 0) / card.propagation_4h) : 0

  const commitTitle = () => {
    if (!card) return
    const t = draftTitle.trim()
    if (t && t !== card.title) onUpdate(card.id, { title: t })
    setEditingTitle(false)
  }
  const cancelTitle = () => setEditingTitle(false)

  const startCommentEdit = () => {
    if (!card) return
    setDraftComment(card.comment)
    setEditingComment(true)
  }
  const commitComment = () => {
    if (!card) return
    const t = draftComment.trim()
    if (t !== card.comment) onUpdate(card.id, { comment: t })
    setEditingComment(false)
  }
  const cancelComment = () => setEditingComment(false)

  return (
    <Dialog open={!!card} onOpenChange={(open) => !open && onClose()}>
      <DialogPortal>
        <DialogOverlay className="bg-slate-900/40 backdrop-blur-sm" />
        <DialogPrimitive.Content
          data-slot="dialog-content"
          className="data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 fixed left-[50%] top-[50%] z-50 w-full max-w-[calc(100%-2rem)] translate-x-[-50%] translate-y-[-50%] rounded-2xl border border-slate-200/80 bg-white/95 p-6 shadow-[0_24px_64px_-16px_rgba(15,23,42,0.35)] backdrop-blur duration-200 outline-none sm:max-w-md"
        >
          {card && (
            <>
              <DialogTitle className="sr-only">卡片详情</DialogTitle>

              {/* 1. 头部：类型胶囊 + 状态徽章 + 关闭 */}
              <div className="flex items-center gap-2">
                <span
                  className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] ${TAGS[card.type].pill}`}
                >
                  <span className={`h-1.5 w-1.5 rounded-full ${TAGS[card.type].dot}`} />
                  {card.type}
                </span>
                {published ? (
                  <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] text-emerald-700">
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                    已发布
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 rounded-full border border-dashed border-slate-300 px-2 py-0.5 text-[11px] text-slate-400">
                    <span className="h-1.5 w-1.5 rounded-full bg-slate-300" />
                    待发布
                  </span>
                )}
                <DialogPrimitive.Close
                  aria-label="关闭详情"
                  className="ml-auto flex h-6 w-6 items-center justify-center rounded-full text-slate-400 outline-none transition-colors hover:bg-slate-100 hover:text-slate-600 focus-visible:ring-2 focus-visible:ring-indigo-200"
                >
                  <XIcon className="size-4" />
                </DialogPrimitive.Close>
              </div>

              {/* 2. 大标题：点击 inline 编辑 */}
              {editingTitle ? (
                <input
                  ref={titleInputRef}
                  value={draftTitle}
                  onChange={(e) => setDraftTitle(e.target.value)}
                  onBlur={commitTitle}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitTitle()
                    if (e.key === 'Escape') {
                      e.stopPropagation()
                      cancelTitle()
                    }
                  }}
                  placeholder="输入卡片标题…"
                  className="mt-3 w-full rounded-lg border border-indigo-300 bg-white px-2 py-1.5 text-lg font-semibold leading-snug text-slate-800 focus:outline-none focus:ring-2 focus:ring-indigo-200"
                />
              ) : (
                <h2
                  data-detail-title
                  onClick={() => {
                    setDraftTitle(card.title)
                    setEditingTitle(true)
                  }}
                  title="点击编辑标题"
                  className={`mt-3 cursor-text rounded-lg px-2 py-1.5 -mx-2 text-lg font-semibold leading-snug transition-colors hover:bg-slate-50 ${
                    card.title ? 'text-slate-900' : 'text-slate-300'
                  }`}
                >
                  {card.title || '未命名卡片'}
                </h2>
              )}

              {/* 3. 信息网格 */}
              <div className="mt-4 grid grid-cols-2 gap-3">
                <div className="rounded-xl bg-slate-50 px-3 py-2.5">
                  <p className="text-[10px] text-slate-400">计划发布时间</p>
                  <p className="mt-0.5 text-[13px] font-medium tabular-nums text-slate-700">
                    {formatPublishAt(card.publish_at)}
                  </p>
                </div>
                <div className="rounded-xl bg-slate-50 px-3 py-2.5">
                  <p className="text-[10px] text-slate-400">归属产品</p>
                  <p className="mt-0.5 truncate text-[13px] font-medium text-slate-700">
                    {product?.name ?? card.product_id}{' '}
                    <span className="text-[11px] font-normal text-slate-400">{card.product_id}</span>
                  </p>
                </div>
              </div>

              {/* 4. 指标区 */}
              {published ? (
                <div className="mt-4">
                  <div className="grid grid-cols-3 divide-x divide-slate-100 rounded-xl border border-slate-100 bg-slate-50/60 py-3">
                    <div className="px-3 text-center">
                      <p className="text-[10px] text-slate-400">ROI</p>
                      <p className="mt-0.5 text-lg font-semibold tabular-nums text-slate-800">
                        {formatRoi(card.roi!)}
                      </p>
                    </div>
                    <div className="px-3 text-center">
                      <p className="text-[10px] text-slate-400">曝光 · 4h</p>
                      <p className="mt-0.5 text-lg font-semibold tabular-nums text-slate-800">
                        {formatCompact(card.propagation_4h ?? 0)}
                      </p>
                    </div>
                    <div className="px-3 text-center">
                      <p className="text-[10px] text-slate-400">互动 · 4h</p>
                      <p className="mt-0.5 text-lg font-semibold tabular-nums text-slate-800">
                        {formatCompact(card.engagement_4h ?? 0)}
                      </p>
                    </div>
                  </div>
                  {/* 互动率 = engagement_4h / propagation_4h */}
                  <div className="mt-2.5 flex items-center gap-2">
                    <span className="text-[10px] text-slate-400">互动率</span>
                    <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-100">
                      <div
                        className="h-full rounded-full bg-gradient-to-r from-indigo-400 to-violet-500"
                        style={{ width: `${Math.round(rate * 100)}%` }}
                      />
                    </div>
                    <span className="text-[11px] font-medium tabular-nums text-indigo-600">
                      {(rate * 100).toFixed(1)}%
                    </span>
                  </div>
                </div>
              ) : (
                <div className="mt-4 rounded-xl border border-dashed border-slate-200 bg-slate-50/50 py-6 text-center text-xs text-slate-300">
                  内容待发布，发布后 4 小时数据将在此展示
                </div>
              )}

              {/* 5. 备注区：完整展示 + inline 编辑（textarea） */}
              <div className="mt-4">
                <p className="text-[10px] text-slate-400">备注 / 复盘</p>
                {editingComment ? (
                  <textarea
                    autoFocus
                    rows={3}
                    value={draftComment}
                    onChange={(e) => setDraftComment(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault()
                        commitComment()
                      }
                      if (e.key === 'Escape') {
                        e.stopPropagation()
                        cancelComment()
                      }
                    }}
                    onBlur={commitComment}
                    placeholder="添加备注…"
                    className="mt-1.5 w-full resize-none rounded-lg border border-indigo-300 bg-white px-2.5 py-2 text-sm leading-relaxed text-slate-700 focus:outline-none focus:ring-2 focus:ring-indigo-200"
                  />
                ) : (
                  <p
                    onClick={startCommentEdit}
                    title="点击编辑备注"
                    className={`mt-1.5 cursor-text whitespace-pre-wrap rounded-lg px-2.5 py-2 -mx-1 text-sm leading-relaxed transition-colors hover:bg-slate-50 ${
                      card.comment ? 'text-slate-600' : 'text-slate-300'
                    }`}
                  >
                    {card.comment || '添加备注…'}
                  </p>
                )}
              </div>

              {/* 6. 底部：删除 */}
              <div className="mt-5 flex justify-end">
                <button
                  type="button"
                  onClick={() => onDelete(card.id)}
                  className="rounded-lg px-3 py-1.5 text-sm text-rose-500 transition-colors hover:bg-rose-50 hover:text-rose-600"
                >
                  删除卡片
                </button>
              </div>
            </>
          )}
        </DialogPrimitive.Content>
      </DialogPortal>
    </Dialog>
  )
}
