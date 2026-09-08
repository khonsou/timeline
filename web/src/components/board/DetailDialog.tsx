import { useEffect, useMemo, useRef, useState } from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { XIcon } from 'lucide-react'
import { Dialog, DialogOverlay, DialogPortal, DialogTitle } from '@/components/ui/dialog'
import TypePicker from '@/components/board/TypePicker'
import type { ContentItem } from '@timeline/core/types'
import {
  UNKNOWN_PRODUCT_CLS,
  listMembers,
  listProducts,
  resolveMember,
  resolveProduct,
} from '@/lib/content-data'
import { isPublished } from '@timeline/core/board-view'
import { type Orders } from '@timeline/core/board-view'
import { STATUSES } from '@timeline/core/import-core'
import { formatCompact, formatPublishAt, formatRoi } from '@timeline/core/format'
import { matchCards } from '@/lib/card-search'

type EditField =
  | 'publish_at'
  | 'product_id'
  | 'content_owner_id'
  | 'delivery_owner_id'
  | 'roi'
  | 'propagation_4h'
  | 'engagement_4h'
  | 'rate'

interface DetailDialogProps {
  card: ContentItem | null // null = 关闭
  autoEditTitle: boolean // 新增空卡片后标题直接进入编辑态
  onClose: () => void
  onUpdate: (id: string, patch: Partial<ContentItem>) => void
  onDelete: (id: string) => void
  /** v2-M3 F4「前后关系」小节：全量卡片（chip 解析/选择器候选）与排序权重 */
  items: ContentItem[]
  orders: Orders
  /** 编辑只走 pre_ids（唯一写入源）；post_ids 镜像由 core 同步维护 */
  onSetPreIds: (id: string, preIds: string[]) => void
  /** chip 点击跳转定位（复用 F5/F6 定位机制；两视图通用，由 BoardPage 路由） */
  onLocateCard: (id: string) => void
}

const INPUT_BASE =
  'w-full rounded-md border bg-white px-1.5 py-1 text-sm tabular-nums text-slate-700 focus:outline-none focus:ring-2'
const INPUT_OK = 'border-indigo-300 focus:ring-indigo-200'
const INPUT_BAD = 'border-rose-400 focus:ring-rose-200 animate-shake'

/** 备注展示态：纯文本中的 http(s) URL 渲染为可点链接（新标签页打开，点击不冒泡触发弹窗交互） */
const URL_SPLIT_RE = /(https?:\/\/[^\s，。；）)】"'<>]+)/g
const URL_TEST_RE = /^https?:\/\//
function linkify(text: string): React.ReactNode[] {
  return text.split(URL_SPLIT_RE).map((seg, i) =>
    URL_TEST_RE.test(seg) ? (
      <a
        key={i}
        href={seg}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(e) => e.stopPropagation()}
        className="text-indigo-500 underline decoration-indigo-300 underline-offset-2 transition-colors hover:text-indigo-600"
      >
        {seg}
      </a>
    ) : (
      seg
    ),
  )
}

// ---------------------------------------------------------------------------
// v2-M3 F4「前后关系」小节（建边主入口，时间线/关系视图通用；方案 B+ 决策 #11）：
// 前序/后续对称可增删——写路径统一翻译为 pre_ids（前序写本卡；后续写对方卡：
// 加 = 对方卡 pre_ids 加上本卡，删 = 对方卡 pre_ids 减掉本卡），post_ids 恒为 core
// 镜像只读展示。chip 点击跳转定位。
// 选择器复用 F5 搜索的卡片匹配逻辑（matchCards：标题/备注/产品名/负责人）。
// ---------------------------------------------------------------------------
function RelationRow({
  kind,
  card,
  items,
  orders,
  onSetPreIds,
  onLocateCard,
}: {
  kind: 'pre' | 'post'
  card: ContentItem
  items: ContentItem[]
  orders: Orders
  onSetPreIds: (id: string, preIds: string[]) => void
  onLocateCard: (id: string) => void
}) {
  const [pickerOpen, setPickerOpen] = useState(false)
  const [query, setQuery] = useState('')
  const byId = useMemo(() => new Map(items.map((it) => [it.id, it])), [items])
  // 缺省空数组需稳定引用（useMemo 依赖口径，防每次渲染变引用）
  const ids = useMemo(
    () => (kind === 'pre' ? (card.pre_ids ?? []) : (card.post_ids ?? [])),
    [kind, card.pre_ids, card.post_ids],
  )
  // 选择器候选排除：本卡自身 + 该行已关联卡（重复/自环不进候选；成环允许，数据层不禁止）
  const exclude = useMemo(() => new Set([card.id, ...ids]), [card.id, ids])
  const candidates = useMemo(
    () => matchCards(query, items, orders, listProducts(), listMembers(), exclude).slice(0, 20),
    [query, items, orders, exclude],
  )
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (pickerOpen) inputRef.current?.focus()
  }, [pickerOpen])

  const add = (targetId: string) => {
    if (kind === 'pre') {
      onSetPreIds(card.id, [...(card.pre_ids ?? []), targetId])
    } else {
      // 添加后续 = 把本卡写进目标卡的 pre_ids（post_ids 不可直接写，单一写入源铁律）
      const target = byId.get(targetId)
      if (target) onSetPreIds(targetId, [...(target.pre_ids ?? []), card.id])
    }
    setPickerOpen(false)
    setQuery('')
  }

  return (
    <div className="mt-1.5" data-rel-row={kind}>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="w-8 shrink-0 text-[11px] text-slate-400">{kind === 'pre' ? '前序' : '后续'}</span>
        {ids.length === 0 && <span className="text-[11px] text-slate-300">无</span>}
        {ids.map((rid) => {
          const target = byId.get(rid)
          return (
            <span
              key={rid}
              data-rel-chip
              className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-slate-50 py-0.5 pl-2.5 pr-1 text-[11px] text-slate-600"
            >
              <button
                type="button"
                data-rel-locate
                title={`点击定位「${target?.title ?? rid}」`}
                onClick={() => onLocateCard(rid)}
                className="max-w-40 truncate transition-colors hover:text-indigo-600"
              >
                {target?.title || '未命名卡片'}
              </button>
              <button
                type="button"
                data-rel-remove
                aria-label={`移除${kind === 'pre' ? '前序' : '后续'}「${target?.title ?? rid}」`}
                onClick={() => {
                  if (kind === 'pre') {
                    onSetPreIds(card.id, (card.pre_ids ?? []).filter((x) => x !== rid))
                  } else {
                    // 移除后续 = 把本卡从对方卡的 pre_ids 剔除（post_ids 不可直接写，单一写入源铁律；
                    // 并发/失败沿用 onSetPreIds 既有写入路径约定，与删前序同级）
                    const t = byId.get(rid)
                    if (t) onSetPreIds(rid, (t.pre_ids ?? []).filter((x) => x !== card.id))
                  }
                }}
                className="flex h-3.5 w-3.5 items-center justify-center rounded-full text-slate-300 transition-colors hover:bg-rose-100 hover:text-rose-500"
              >
                ×
              </button>
            </span>
          )
        })}
        <button
          type="button"
          data-rel-add={kind}
          onClick={() => {
            setPickerOpen((v) => !v)
            setQuery('')
          }}
          className="rounded-full border border-dashed border-slate-300 px-2 py-0.5 text-[11px] text-slate-400 transition-colors hover:border-indigo-300 hover:text-indigo-500"
        >
          + 添加{kind === 'pre' ? '前序' : '后续'}
        </button>
      </div>
      {pickerOpen && (
        <div data-rel-picker className="relative mt-1.5 rounded-xl border border-slate-200 bg-white p-2 shadow-[0_10px_28px_-10px_rgba(15,23,42,0.25)]">
          <input
            ref={inputRef}
            data-rel-input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.stopPropagation()
                setPickerOpen(false)
              } else if (e.key === 'Enter' && candidates[0]) {
                e.preventDefault()
                add(candidates[0].id)
              }
            }}
            placeholder="搜索标题、备注、产品或负责人…"
            className="w-full rounded-md border border-slate-200 bg-slate-50 px-2 py-1 text-[12px] outline-none focus:border-indigo-300 focus:bg-white"
          />
          <div className="mt-1 max-h-40 overflow-y-auto">
            {query.trim() === '' ? (
              <p className="px-2 py-3 text-center text-[11px] text-slate-300">输入关键词搜索卡片</p>
            ) : candidates.length === 0 ? (
              <p className="px-2 py-3 text-center text-[11px] text-slate-400">没有匹配「{query.trim()}」的卡片</p>
            ) : (
              candidates.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  data-rel-option
                  onClick={() => add(c.id)}
                  className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12px] text-slate-700 transition-colors hover:bg-indigo-50/80"
                >
                  <span className="truncate">{c.title || '未命名卡片'}</span>
                  <span className="ml-auto shrink-0 text-[10px] text-slate-300">{c.status}</span>
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  )
}

export default function DetailDialog({
  card,
  autoEditTitle,
  onClose,
  onUpdate,
  onDelete,
  items,
  orders,
  onSetPreIds,
  onLocateCard,
}: DetailDialogProps) {
  const [editingTitle, setEditingTitle] = useState(false)
  const [draftTitle, setDraftTitle] = useState('')
  const [editingComment, setEditingComment] = useState(false)
  const [draftComment, setDraftComment] = useState('')
  // 6 项字段的统一 inline 编辑状态
  const [editingField, setEditingField] = useState<EditField | null>(null)
  const [draft, setDraft] = useState('')
  const [invalid, setInvalid] = useState(false)
  // 类型选择器展开态：纳入弹窗 Esc 拦截（展开时 Esc 只关选择器）
  const [typePickerOpen, setTypePickerOpen] = useState(false)
  const titleInputRef = useRef<HTMLInputElement>(null)

  // 打开另一张卡时重置编辑态；新增空卡片直接标题编辑
  const cardId = card?.id
  useEffect(() => {
    setEditingComment(false)
    setEditingField(null)
    setInvalid(false)
    setTypePickerOpen(false)
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

  // 负责人信息格（内容/投放共用，镜像「归属产品」格模式）：
  // 展示态未分配（空 id / 目录未命中）→ 淡色「未分配」+ tooltip 保留原始 id；
  // 编辑态为下拉（成员目录 + 顶部「未分配」），未知存量 id 降级显示在「未分配」项
  const ownerCell = (label: string, field: 'content_owner_id' | 'delivery_owner_id') => {
    if (!card) return null
    const owner = resolveMember(card[field])
    const members = listMembers()
    return (
      <div className="rounded-xl bg-slate-50 px-3 py-2.5">
        <p className="text-[10px] text-slate-400">{label}</p>
        {editingField === field ? (
          <select
            data-edit-input={field}
            autoFocus
            // 当前值为空/未知 id 时显示在「未分配」项；原始 id 放 tooltip 排查
            value={members.some((m) => m.id === draft) ? draft : ''}
            title={
              draft && !members.some((m) => m.id === draft) ? `原始 id: ${draft}` : undefined
            }
            onChange={(e) => {
              const v = e.target.value
              onUpdate(
                card.id,
                field === 'content_owner_id'
                  ? { content_owner_id: v }
                  : { delivery_owner_id: v },
              )
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
            <option value="">未分配</option>
            {members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}（{m.id}）
              </option>
            ))}
          </select>
        ) : (
          <p
            data-edit-field={field}
            onClick={() => startField(field, card[field])}
            title={
              owner.unassigned
                ? owner.rawId
                  ? `原始 id: ${owner.rawId}（点击编辑）`
                  : '未分配（点击编辑）'
                : '点击编辑'
            }
            className="mt-0.5 cursor-pointer truncate rounded px-1 -mx-1 text-[13px] font-medium text-slate-700 transition-colors hover:bg-white"
          >
            {owner.unassigned ? (
              <span data-detail-owner-unassigned className={UNKNOWN_PRODUCT_CLS}>
                未分配
              </span>
            ) : (
              <>
                {owner.name}{' '}
                <span className="text-[11px] font-normal text-slate-400">{card[field]}</span>
              </>
            )}
          </p>
        )}
      </div>
    )
  }

  return (
    <Dialog open={!!card} onOpenChange={(open) => !open && onClose()}>
      <DialogPortal>
        <DialogOverlay className="bg-slate-900/40 backdrop-blur-sm" />
        <DialogPrimitive.Content
          data-slot="dialog-content"
          onEscapeKeyDown={(e) => {
            // 任意 inline 编辑态 / 类型选择器展开时，Esc 只取消编辑（或只关选择器）、不关弹窗：
            // Radix 在 document 监听 Escape，输入框内的 stopPropagation 挡不住，
            // 必须在弹窗层 preventDefault（读到的是当前渲染的编辑态，先于取消生效）
            if (editingTitle || editingComment || editingField || typePickerOpen) e.preventDefault()
          }}
          className="data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 fixed left-[50%] top-[50%] z-50 flex max-h-[85vh] w-[calc(100vw-2rem)] max-w-2xl translate-x-[-50%] translate-y-[-50%] flex-col overflow-hidden rounded-2xl border border-slate-200/80 bg-white/95 shadow-[0_24px_64px_-16px_rgba(15,23,42,0.35)] backdrop-blur duration-200 outline-none"
        >
          {card && (
            <>
              <DialogTitle className="sr-only">卡片详情</DialogTitle>

              {/* 1. 头部（固定不滚）：类型胶囊（可点击换类型）+ 状态徽章 + 关闭 */}
              <div className="flex shrink-0 items-center gap-2 border-b border-slate-100 px-6 pb-3 pt-4 shadow-[0_1px_3px_rgba(15,23,42,0.04)]">
                <TypePicker
                  key={card.id}
                  value={card.type}
                  onChange={(t) => onUpdate(card.id, { type: t })}
                  onOpenChange={setTypePickerOpen}
                />
                {/* 状态徽章（三态）：已发布 = emerald 实心；待发布 = 虚线灰；待执行 = 虚线浅灰空心点 */}
                {card.status === '已发布' ? (
                  <span data-status-badge className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] text-emerald-700">
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                    已发布
                  </span>
                ) : card.status === '待发布' ? (
                  <span data-status-badge className="inline-flex items-center gap-1 rounded-full border border-dashed border-slate-300 px-2 py-0.5 text-[11px] text-slate-400">
                    <span className="h-1.5 w-1.5 rounded-full bg-slate-300" />
                    待发布
                  </span>
                ) : (
                  <span data-status-badge className="inline-flex items-center gap-1 rounded-full border border-dashed border-slate-300 px-2 py-0.5 text-[11px] text-slate-400">
                    <span className="h-1.5 w-1.5 rounded-full border border-slate-300" />
                    待执行
                  </span>
                )}
                <DialogPrimitive.Close
                  aria-label="关闭详情"
                  className="ml-auto flex h-6 w-6 items-center justify-center rounded-full text-slate-400 outline-none transition-colors hover:bg-slate-100 hover:text-slate-600 focus-visible:ring-2 focus-visible:ring-indigo-200"
                >
                  <XIcon className="size-4" />
                </DialogPrimitive.Close>
              </div>

              {/* 2~5. 内容区：独立纵向滚动（标题 / 信息网格 / 指标区 / 备注区），滚动条细且半透明 */}
              <div
                data-detail-scroll
                className="min-h-0 flex-1 overflow-y-auto px-6 pb-4 [scrollbar-color:rgba(148,163,184,0.45)_transparent] [scrollbar-width:thin] [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-slate-300/50 [&::-webkit-scrollbar-track]:bg-transparent"
              >
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
                      // 当前值为空/未知 id 时显示在「不明」项；原始 id 放 tooltip 排查
                      value={listProducts().some((p) => p.id === draft) ? draft : ''}
                      title={
                        draft && !listProducts().some((p) => p.id === draft)
                          ? `原始 product_id: ${draft}`
                          : undefined
                      }
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
                      <option value="">不明（不归属）</option>
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
                      title={
                        product?.unknown
                          ? product.rawId
                            ? `原始 product_id: ${product.rawId}（点击编辑）`
                            : '未归属产品（点击编辑）'
                          : '点击编辑'
                      }
                      className="mt-0.5 cursor-pointer truncate rounded px-1 -mx-1 text-[13px] font-medium text-slate-700 transition-colors hover:bg-white"
                    >
                      {product?.unknown ? (
                        <span data-detail-product-unknown className={UNKNOWN_PRODUCT_CLS}>
                          不明
                        </span>
                      ) : (
                        <>
                          {product?.name}{' '}
                          <span className="text-[11px] font-normal text-slate-400">
                            {card.product_id}
                          </span>
                        </>
                      )}
                    </p>
                  )}
                </div>
                {ownerCell('内容负责人', 'content_owner_id')}
                {ownerCell('投放负责人', 'delivery_owner_id')}
              </div>

              {/* 3.5 状态分段：点击即切换；切到非「已发布」时 App 层强制三指标置 null（锁定） */}
              <div data-status-seg className="mt-3 flex items-center gap-1 rounded-xl bg-slate-50 p-1">
                <span className="shrink-0 px-2 text-[10px] text-slate-400">状态</span>
                {STATUSES.map((s) => {
                  const active = card.status === s
                  return (
                    <button
                      key={s}
                      type="button"
                      data-status-option={s}
                      onClick={() => !active && onUpdate(card.id, { status: s })}
                      className={`flex-1 rounded-lg px-2 py-1 text-[12px] transition-colors ${
                        active
                          ? s === '已发布'
                            ? 'bg-emerald-500 font-medium text-white shadow-sm'
                            : 'bg-slate-800 font-medium text-white shadow-sm'
                          : 'text-slate-500 hover:bg-white'
                      }`}
                    >
                      {s}
                    </button>
                  )
                })}
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
                  <p className="text-xs text-slate-300">
                    状态为{card.status}时指标锁定，发布后 4 小时数据将在此展示
                  </p>
                  <p className="mt-1 text-[10px] text-slate-300">
                    切换为「已发布」即可录入数据
                  </p>
                </div>
              )}

              {/* 5. 备注区：链接可点的展示态 + 显式「编辑」按钮进入 textarea */}
              <div className="mt-4">
                <div className="flex items-center justify-between">
                  <p className="text-[10px] text-slate-400">备注 / 复盘</p>
                  {!editingComment && (
                    <button
                      type="button"
                      data-comment-edit
                      onClick={startCommentEdit}
                      className="rounded-md px-2 py-0.5 text-[11px] text-slate-400 transition-colors hover:bg-slate-100 hover:text-indigo-600"
                    >
                      编辑
                    </button>
                  )}
                </div>
                {editingComment ? (
                  <textarea
                    data-edit-input="comment"
                    autoFocus
                    rows={8}
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
                    className="mt-1.5 min-h-40 w-full resize-y rounded-lg border border-indigo-300 bg-white px-2.5 py-2 text-sm leading-relaxed text-slate-700 focus:outline-none focus:ring-2 focus:ring-indigo-200"
                  />
                ) : (
                  <p
                    data-edit-field="comment"
                    className={`mt-1.5 whitespace-pre-line rounded-lg px-2.5 py-2 -mx-1 text-sm leading-relaxed ${
                      card.comment ? 'text-slate-600' : 'text-slate-300'
                    }`}
                  >
                    {card.comment ? linkify(card.comment) : '添加备注…'}
                  </p>
                )}
              </div>

              {/* 5.5 前后关系（v2-M3 F4 建边主入口）：前序可编辑 / 后续镜像只读 + 选择器添加 */}
              <div className="mt-4" data-relations>
                <p className="text-[10px] text-slate-400">前后关系</p>
                <RelationRow
                  kind="pre"
                  card={card}
                  items={items}
                  orders={orders}
                  onSetPreIds={onSetPreIds}
                  onLocateCard={onLocateCard}
                />
                <RelationRow
                  kind="post"
                  card={card}
                  items={items}
                  orders={orders}
                  onSetPreIds={onSetPreIds}
                  onLocateCard={onLocateCard}
                />
              </div>
              </div>{/* /2~5 内容区滚动容器 */}

              {/* 6. 底部（固定不滚）：删除 */}
              <div className="flex shrink-0 justify-end border-t border-slate-100 px-6 py-3">
                <button
                  type="button"
                  data-detail-delete
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
