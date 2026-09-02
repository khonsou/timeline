import { useEffect, useRef, useState } from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { XIcon } from 'lucide-react'
import { Dialog, DialogOverlay, DialogPortal, DialogTitle } from '@/components/ui/dialog'
import type { ContentItem } from '@/types/content'
import { TAGS, listProducts, resolveProduct } from '@/lib/content-data'
import { isPublished } from '@/lib/board-view'
import { formatCompact, formatPublishAt, formatRoi } from '@/lib/format'

type EditField = 'publish_at' | 'product_id' | 'roi' | 'propagation_4h' | 'engagement_4h' | 'rate'

interface DetailDialogProps {
  card: ContentItem | null // null = 关闭
  autoEditTitle: boolean // 新增空卡片后标题直接进入编辑态
  onClose: () => void
  onUpdate: (id: string, patch: Partial<ContentItem>) => void
  onDelete: (id: string) => void
}

const INPUT_BASE =
  'w-full rounded-md border bg-white px-1.5 py-1 text-sm tabular-nums text-slate-700 focus:outline-none focus:ring-2'
const INPUT_OK = 'border-indigo-300 focus:ring-indigo-200'
const INPUT_BAD = 'border-rose-400 focus:ring-rose-200 animate-shake'

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
  // 6 项字段的统一 inline 编辑状态
  const [editingField, setEditingField] = useState<EditField | null>(null)
  const [draft, setDraft] = useState('')
  const [invalid, setInvalid] = useState(false)
  const titleInputRef = useRef<HTMLInputElement>(null)

  // 打开另一张卡时重置编辑态；新增空卡片直接标题编辑
  const cardId = card?.id
  useEffect(() => {
    setEditingComment(false)
    setEditingField(null)
    setInvalid(false)
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

  const published = card ? isPublished(card) : false
  const product = card ? resolveProduct(card.product_id) : undefined
  const rate =
    card && card.propagation_4h ? Math.min(1, (card.engagement_4h ?? 0) / card.propagation_4h) : 0
  const rateEditable = !!card && published && !!card.propagation_4h

  // ---------------- 标题 / 备注（原有模式） ----------------
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

  // ---------------- 6 项字段编辑 ----------------
  const startField = (field: EditField, initial: string) => {
    setEditingField(field)
    setDraft(initial)
    setInvalid(false)
  }
  const cancelField = () => {
    setEditingField(null)
    setInvalid(false)
  }

  /** 校验并提交；非法输入：不保存，红边抖动提示；失焦时非法则直接回退 */
  const commitField = (fromBlur = false) => {
    if (!card || !editingField) return
    const bad = () => {
      if (fromBlur) cancelField()
      else setInvalid(true)
    }
    const v = draft.trim()

    switch (editingField) {
      case 'publish_at': {
        if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(v)) return bad()
        const [dp, tp] = v.split('T')
        const [y, m, d] = dp.split('-').map(Number)
        const [h, mi] = tp.split(':').map(Number)
        const dt = new Date(y, m - 1, d, h, mi)
        if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d || h > 23 || mi > 59)
          return bad()
        if (v !== card.publish_at) onUpdate(card.id, { publish_at: v })
        break
      }
      case 'roi': {
        if (!/^\d+(\.\d+)?$/.test(v)) return bad()
        const n = Math.round(Number(v) * 10) / 10
        if (n !== card.roi) onUpdate(card.id, { roi: n })
        break
      }
      case 'propagation_4h': {
        if (!/^\d+$/.test(v)) return bad()
        const n = Math.round(Number(v))
        if (n !== card.propagation_4h) onUpdate(card.id, { propagation_4h: n })
        break
      }
      case 'engagement_4h': {
        if (!/^\d+$/.test(v)) return bad()
        const n = Math.round(Number(v))
        if (n !== card.engagement_4h) onUpdate(card.id, { engagement_4h: n })
        break
      }
      case 'rate': {
        // 百分数输入（6.4 = 6.4%），反推 engagement_4h = round(propagation × rate)
        if (!/^\d+(\.\d+)?$/.test(v)) return bad()
        if (!card.propagation_4h) return bad()
        const n = Math.round(card.propagation_4h * (Number(v) / 100))
        if (n !== card.engagement_4h) onUpdate(card.id, { engagement_4h: n })
        break
      }
    }
    cancelField()
  }

  const fieldKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') commitField()
    if (e.key === 'Escape') {
      e.stopPropagation()
      cancelField()
    }
  }

  // 可编辑统计小格的容器样式（hover 编辑提示）
  const cellCls =
    'group/cell cursor-pointer rounded-lg px-3 py-1 text-center transition-colors hover:bg-white'
  const inputCls = `${INPUT_BASE} ${invalid ? INPUT_BAD : INPUT_OK} text-center`

  return (
    <Dialog open={!!card} onOpenChange={(open) => !open && onClose()}>
      <DialogPortal>
        <DialogOverlay className="bg-slate-900/40 backdrop-blur-sm" />
        <DialogPrimitive.Content
          data-slot="dialog-content"
          onEscapeKeyDown={(e) => {
            // 任意 inline 编辑态时 Esc 只取消编辑、不关弹窗：
            // Radix 在 document 监听 Escape，输入框内的 stopPropagation 挡不住，
            // 必须在弹窗层 preventDefault（读到的是当前渲染的编辑态，先于取消生效）
            if (editingTitle || editingComment || editingField) e.preventDefault()
          }}
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

              {/* 3. 信息网格：计划发布时间 / 归属产品（均可点击编辑） */}
              <div className="mt-4 grid grid-cols-2 gap-3">
                <div className="rounded-xl bg-slate-50 px-3 py-2.5">
                  <p className="text-[10px] text-slate-400">计划发布时间</p>
                  {editingField === 'publish_at' ? (
                    <input
                      data-edit-input="publish_at"
                      autoFocus
                      type="datetime-local"
                      value={draft}
                      onChange={(e) => {
                        setDraft(e.target.value)
                        setInvalid(false)
                      }}
                      onBlur={() => commitField(true)}
                      onKeyDown={fieldKeyDown}
                      className={`mt-0.5 ${INPUT_BASE} ${invalid ? INPUT_BAD : INPUT_OK}`}
                    />
                  ) : (
                    <p
                      data-edit-field="publish_at"
                      onClick={() => startField('publish_at', card.publish_at)}
                      title="点击编辑"
                      className="mt-0.5 cursor-pointer rounded px-1 -mx-1 text-[13px] font-medium tabular-nums text-slate-700 transition-colors hover:bg-white"
                    >
                      {formatPublishAt(card.publish_at)}
                    </p>
                  )}
                </div>
                <div className="rounded-xl bg-slate-50 px-3 py-2.5">
                  <p className="text-[10px] text-slate-400">归属产品</p>
                  {editingField === 'product_id' ? (
                    <select
                      data-edit-input="product_id"
                      autoFocus
                      value={draft}
                      onChange={(e) => {
                        onUpdate(card.id, { product_id: e.target.value })
                        cancelField()
                      }}
                      onBlur={cancelField}
                      onKeyDown={(e) => {
                        if (e.key === 'Escape') {
                          e.stopPropagation()
                          cancelField()
                        }
                      }}
                      className={`mt-0.5 ${INPUT_BASE} ${INPUT_OK}`}
                    >
                      {listProducts().map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}（{p.id}）
                        </option>
                      ))}
                    </select>
                  ) : (
                    <p
                      data-edit-field="product_id"
                      onClick={() => startField('product_id', card.product_id)}
                      title="点击编辑"
                      className="mt-0.5 cursor-pointer truncate rounded px-1 -mx-1 text-[13px] font-medium text-slate-700 transition-colors hover:bg-white"
                    >
                      {product?.name ?? card.product_id}{' '}
                      <span className="text-[11px] font-normal text-slate-400">{card.product_id}</span>
                    </p>
                  )}
                </div>
              </div>

              {/* 4. 指标区：已发布 = 可编辑统计格 + 可编辑互动率；待发布 = 占位 + 引导 */}
              {published ? (
                <div className="mt-4">
                  <div className="grid grid-cols-3 divide-x divide-slate-100 rounded-xl border border-slate-100 bg-slate-50/60 py-2">
                    {/* ROI */}
                    <div className={cellCls} data-edit-field="roi" onClick={() => editingField !== 'roi' && startField('roi', card.roi === null ? '' : String(card.roi))} title="点击编辑">
                      <p className="text-[10px] text-slate-400">ROI</p>
                      {editingField === 'roi' ? (
                        <input
                          data-edit-input="roi"
                          autoFocus
                          type="number"
                          step={0.1}
                          min={0}
                          value={draft}
                          onChange={(e) => { setDraft(e.target.value); setInvalid(false) }}
                          onBlur={() => commitField(true)}
                          onKeyDown={fieldKeyDown}
                          className={`mt-0.5 ${inputCls}`}
                        />
                      ) : (
                        <p className="mt-0.5 text-lg font-semibold tabular-nums text-slate-800">
                          {card.roi === null ? '—' : formatRoi(card.roi)}
                        </p>
                      )}
                    </div>
                    {/* 曝光·4h */}
                    <div className={cellCls} data-edit-field="propagation_4h" onClick={() => editingField !== 'propagation_4h' && startField('propagation_4h', card.propagation_4h === null ? '' : String(card.propagation_4h))} title="点击编辑">
                      <p className="text-[10px] text-slate-400">曝光 · 4h</p>
                      {editingField === 'propagation_4h' ? (
                        <input
                          data-edit-input="propagation_4h"
                          autoFocus
                          type="number"
                          min={0}
                          step={1}
                          value={draft}
                          onChange={(e) => { setDraft(e.target.value); setInvalid(false) }}
                          onBlur={() => commitField(true)}
                          onKeyDown={fieldKeyDown}
                          className={`mt-0.5 ${inputCls}`}
                        />
                      ) : (
                        <p className="mt-0.5 text-lg font-semibold tabular-nums text-slate-800">
                          {card.propagation_4h === null ? '—' : formatCompact(card.propagation_4h)}
                        </p>
                      )}
                    </div>
                    {/* 互动·4h */}
                    <div className={cellCls} data-edit-field="engagement_4h" onClick={() => editingField !== 'engagement_4h' && startField('engagement_4h', card.engagement_4h === null ? '' : String(card.engagement_4h))} title="点击编辑">
                      <p className="text-[10px] text-slate-400">互动 · 4h</p>
                      {editingField === 'engagement_4h' ? (
                        <input
                          data-edit-input="engagement_4h"
                          autoFocus
                          type="number"
                          min={0}
                          step={1}
                          value={draft}
                          onChange={(e) => { setDraft(e.target.value); setInvalid(false) }}
                          onBlur={() => commitField(true)}
                          onKeyDown={fieldKeyDown}
                          className={`mt-0.5 ${inputCls}`}
                        />
                      ) : (
                        <p className="mt-0.5 text-lg font-semibold tabular-nums text-slate-800">
                          {card.engagement_4h === null ? '—' : formatCompact(card.engagement_4h)}
                        </p>
                      )}
                    </div>
                  </div>
                  {/* 互动率（派生，可编辑反推 engagement_4h） */}
                  <div className="mt-2.5 flex items-center gap-2">
                    <span className="text-[10px] text-slate-400">互动率</span>
                    <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-100">
                      <div
                        className="h-full rounded-full bg-gradient-to-r from-indigo-400 to-violet-500 transition-all duration-150"
                        style={{ width: `${Math.round(rate * 100)}%` }}
                      />
                    </div>
                    {editingField === 'rate' ? (
                      <input
                        data-edit-input="rate"
                        autoFocus
                        type="number"
                        min={0}
                        step={0.1}
                        value={draft}
                        onChange={(e) => { setDraft(e.target.value); setInvalid(false) }}
                        onBlur={() => commitField(true)}
                        onKeyDown={fieldKeyDown}
                        className={`w-16 ${INPUT_BASE} ${invalid ? INPUT_BAD : INPUT_OK} text-center`}
                      />
                    ) : rateEditable ? (
                      <button
                        type="button"
                        data-edit-field="rate"
                        title="点击编辑（反推互动量）"
                        onClick={() => startField('rate', (rate * 100).toFixed(1))}
                        className="cursor-pointer rounded px-1 text-[11px] font-medium tabular-nums text-indigo-600 transition-colors hover:bg-indigo-50"
                      >
                        {(rate * 100).toFixed(1)}%
                      </button>
                    ) : (
                      <span className="text-[11px] tabular-nums text-slate-300" title="需先有曝光量">
                        {card.propagation_4h ? `${(rate * 100).toFixed(1)}%` : '—'}
                        <span className="ml-1 text-[10px]">需先有曝光量</span>
                      </span>
                    )}
                  </div>
                </div>
              ) : (
                <div className="mt-4 rounded-xl border border-dashed border-slate-200 bg-slate-50/50 py-5 text-center">
                  <p className="text-xs text-slate-300">内容待发布，发布后 4 小时数据将在此展示</p>
                  <p className="mt-1 text-[10px] text-slate-300">
                    将计划发布时间改到过去即可录入数据
                  </p>
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
