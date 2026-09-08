/**
 * v2-M1 F5 看板内卡片搜索面板（SearchPalette）。
 *
 * - 范围：当前看板全量 items（含 61 列滑动窗口外未渲染的卡片）
 * - 匹配：title + comment + 产品名 + 内容/投放负责人姓名，子串、不区分大小写
 *   （v2-M1c 测试反馈补充产品/负责人；卡片量级几十到几百，内存过滤即可）
 * - 排序：按日期升序 → 列内 orders 升序（自然序，不做相关度排序）
 * - 交互：⌘K / Ctrl+K 唤起（BoardPage 挂载快捷键），Esc 关闭，Enter 定位第一条，
 *   ↑/↓ 移动选中；点击结果 → onLocate（与 F6 分享链接共用 Board.revealCard 定位机制）
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link2, Search } from 'lucide-react'
import type { ContentItem, Group } from '@timeline/core/types'
import { publishDateOf, type Orders } from '@timeline/core/board-view'

interface SearchPaletteProps {
  open: boolean
  items: ContentItem[]
  orders: Orders
  /** 产品目录（product_id → 名称参与匹配；v2-M1c 测试反馈补充） */
  products: { id: string; name: string }[]
  /** 成员目录（内容/投放负责人 id → 姓名参与匹配；v2-M1c 测试反馈补充） */
  members: { id: string; name: string }[]
  /** v2-M2 F3 统一分组模型：结果行副标题恒 = 分组名（未分组/悬空 → 「未分组」） */
  groups?: Group[]
  onClose: () => void
  /** 点击结果：定位并高亮卡片（F5/F6 共用机制在 Board 内） */
  onLocate: (id: string) => void
  /** 结果行内复制分享链接（F6 入口之一） */
  onCopyLink: (id: string) => void
}

const MAX_RESULTS = 50

export default function SearchPalette({
  open,
  items,
  orders,
  products,
  members,
  groups = [],
  onClose,
  onLocate,
  onCopyLink,
}: SearchPaletteProps) {
  const [query, setQuery] = useState('')
  const [activeIdx, setActiveIdx] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  // 打开时清空上次查询（render 期调整状态，React 官方模式，避免 effect 级联渲染）
  const [prevOpen, setPrevOpen] = useState(open)
  if (open !== prevOpen) {
    setPrevOpen(open)
    if (open) {
      setQuery('')
      setActiveIdx(0)
    }
  }
  // 打开后聚焦输入框（DOM 副作用，只走 effect）
  useEffect(() => {
    if (open) inputRef.current?.focus()
  }, [open])

  const results = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return []
    // v2-M1c：产品名与负责人（内容/投放）姓名参与匹配——卡片上只存 id，按目录解析名称
    const productName = new Map(products.map((p) => [p.id, p.name.toLowerCase()]))
    const memberName = new Map(members.map((m) => [m.id, m.name.toLowerCase()]))
    return items
      .filter(
        (c) =>
          c.title.toLowerCase().includes(q) ||
          (c.comment ?? '').toLowerCase().includes(q) ||
          (productName.get(c.product_id) ?? '').includes(q) ||
          (memberName.get(c.content_owner_id) ?? '').includes(q) ||
          (memberName.get(c.delivery_owner_id) ?? '').includes(q),
      )
      .sort(
        (a, b) =>
          publishDateOf(a).localeCompare(publishDateOf(b)) ||
          (orders[a.id] ?? 0) - (orders[b.id] ?? 0),
      )
      .slice(0, MAX_RESULTS)
  }, [items, orders, products, members, query])

  // v2-M2 统一分组模型：结果行副标题恒 = 分组名（未分组/悬空 → 「未分组」）
  const groupName = useMemo(() => new Map(groups.map((g) => [g.id, g.name])), [groups])
  const subtitleOf = (c: ContentItem): string =>
    c.group_id ? (groupName.get(c.group_id) ?? '未分组') : '未分组'

  if (!open) return null

  const locate = (id: string) => {
    onLocate(id)
    onClose()
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      onClose()
    } else if (e.key === 'Enter') {
      const r = results[Math.min(activeIdx, results.length - 1)]
      if (r) locate(r.id)
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIdx((i) => Math.min(i + 1, results.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIdx((i) => Math.max(i - 1, 0))
    }
  }

  return (
    <div
      data-search-palette
      className="fixed inset-0 z-50 flex items-start justify-center bg-slate-900/30 pt-[14vh] backdrop-blur-[2px]"
      onClick={onClose}
    >
      <div
        className="flex max-h-[60vh] w-[calc(100vw-2rem)] max-w-xl flex-col overflow-hidden rounded-2xl border border-slate-200/80 bg-white/95 shadow-[0_24px_64px_-16px_rgba(15,23,42,0.35)] backdrop-blur"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex shrink-0 items-center gap-2 border-b border-slate-100 px-4 py-3">
          <Search className="size-4 shrink-0 text-slate-400" />
          <input
            ref={inputRef}
            data-search-input
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setActiveIdx(0) // 查询变化后选中项回到第一条
            }}
            onKeyDown={onKeyDown}
            placeholder="搜索标题、备注、产品或负责人…"
            className="w-full bg-transparent text-sm text-slate-800 outline-none placeholder:text-slate-300"
          />
          <kbd className="shrink-0 rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[10px] text-slate-400">
            Esc
          </kbd>
        </div>

        <div data-search-results className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {query.trim() === '' ? (
            <p className="px-3 py-6 text-center text-xs text-slate-300">
              输入关键词搜索本看板全部 {items.length} 张卡片（含窗口外）
            </p>
          ) : results.length === 0 ? (
            <p data-search-empty className="px-3 py-6 text-center text-xs text-slate-400">
              没有匹配「{query.trim()}」的卡片
            </p>
          ) : (
            results.map((c, i) => (
              <div
                key={c.id}
                data-search-result
                data-card-id={c.id}
                role="button"
                tabIndex={-1}
                onClick={() => locate(c.id)}
                onMouseEnter={() => setActiveIdx(i)}
                className={`flex cursor-pointer items-center gap-2 rounded-xl px-3 py-2 ${
                  i === activeIdx ? 'bg-indigo-50/80' : ''
                }`}
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] font-medium text-slate-700">
                    {c.title || '未命名卡片'}
                  </p>
                  <p className="mt-0.5 flex items-center gap-1.5 text-[11px] text-slate-400">
                    <span data-search-subtitle className="tabular-nums">{subtitleOf(c)}</span>
                    <span>·</span>
                    <span>{c.status}</span>
                    {c.dimmed === true && (
                      <>
                        <span>·</span>
                        <span data-search-dimmed className="text-slate-300">
                          置灰
                        </span>
                      </>
                    )}
                  </p>
                </div>
                <button
                  type="button"
                  data-search-copy
                  aria-label="复制分享链接"
                  title="复制分享链接"
                  onClick={(e) => {
                    e.stopPropagation()
                    onCopyLink(c.id)
                  }}
                  className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-slate-300 transition-colors hover:bg-slate-100 hover:text-indigo-500"
                >
                  <Link2 className="size-3.5" />
                </button>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  )
}
