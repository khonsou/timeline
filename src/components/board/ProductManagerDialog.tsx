import { useEffect, useRef, useState } from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { XIcon } from 'lucide-react'
import { Dialog, DialogOverlay, DialogPortal, DialogTitle } from '@/components/ui/dialog'
import type { ContentItem } from '@/types/content'
import type { Product } from '@/lib/content-data'

interface ProductManagerDialogProps {
  open: boolean
  products: Product[]
  items: ContentItem[] // 使用计数（按 items 统计引用）
  onClose: () => void
  onApply: (next: Product[]) => void
}

/** 扫描现有 id 数字后缀取 max+1，格式 P-<四位>；无数字后缀 id 时从 P-1000 起 */
function nextProductId(products: Product[]): string {
  let max = 999
  for (const p of products) {
    const m = p.id.match(/(\d+)$/)
    if (m) max = Math.max(max, Number(m[1]))
  }
  return `P-${String(max + 1).padStart(4, '0')}`
}

/**
 * 产品管理弹窗（与 DetailDialog 同一 Dialog 模式）：
 * 每行 id + 名称（inline 编辑）+ 使用计数 + 删除 ×（立即删除，引用卡片按设计降级「不明」）；
 * 底部新增行（id 自动生成）；空目录占位。P-1000 不特殊保护，可改可删。
 */
export default function ProductManagerDialog({
  open,
  products,
  items,
  onClose,
  onApply,
}: ProductManagerDialogProps) {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [newName, setNewName] = useState('')
  const editInputRef = useRef<HTMLInputElement>(null)

  // 弹窗关闭/目录变化时退出编辑态
  useEffect(() => {
    if (!open) {
      setEditingId(null)
      setNewName('')
    }
  }, [open])
  useEffect(() => {
    if (editingId) editInputRef.current?.select()
  }, [editingId])

  const startEdit = (p: Product) => {
    setDraft(p.name)
    setEditingId(p.id)
  }
  const commitEdit = () => {
    if (!editingId) return
    const name = draft.trim()
    const target = products.find((p) => p.id === editingId)
    if (name && target && name !== target.name) {
      onApply(products.map((p) => (p.id === editingId ? { ...p, name } : p)))
    }
    // 空名拒绝保存：直接退出编辑态（不改数据）
    setEditingId(null)
  }
  const cancelEdit = () => setEditingId(null)

  const addProduct = () => {
    const name = newName.trim()
    if (!name) return // 空名拒绝
    onApply([...products, { id: nextProductId(products), name }])
    setNewName('')
  }

  const usageOf = (id: string) => items.filter((it) => it.product_id === id).length

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogPortal>
        <DialogOverlay className="bg-slate-900/40 backdrop-blur-sm" />
        <DialogPrimitive.Content
          data-products-dialog
          onEscapeKeyDown={(e) => {
            // 名称编辑态时 Esc 只取消编辑、不关弹窗（同 DetailDialog 拦截层级）
            if (editingId) e.preventDefault()
          }}
          className="data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 fixed left-[50%] top-[50%] z-50 flex max-h-[85vh] w-[calc(100vw-2rem)] max-w-lg translate-x-[-50%] translate-y-[-50%] flex-col overflow-hidden rounded-2xl border border-slate-200/80 bg-white/95 shadow-[0_24px_64px_-16px_rgba(15,23,42,0.35)] backdrop-blur duration-200 outline-none"
        >
          <DialogTitle className="sr-only">产品管理</DialogTitle>

          {/* 头部（固定不滚） */}
          <div className="flex shrink-0 items-center gap-2 border-b border-slate-100 px-6 pb-3 pt-4 shadow-[0_1px_3px_rgba(15,23,42,0.04)]">
            <h2 className="text-[15px] font-semibold text-slate-800">产品管理</h2>
            <span className="text-[11px] tabular-nums text-slate-400">{products.length} 个</span>
            <DialogPrimitive.Close
              aria-label="关闭产品管理"
              className="ml-auto flex h-6 w-6 items-center justify-center rounded-full text-slate-400 outline-none transition-colors hover:bg-slate-100 hover:text-slate-600 focus-visible:ring-2 focus-visible:ring-indigo-200"
            >
              <XIcon className="size-4" />
            </DialogPrimitive.Close>
          </div>

          {/* 列表（独立滚动） */}
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-2 [scrollbar-color:rgba(148,163,184,0.45)_transparent] [scrollbar-width:thin] [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-slate-300/50 [&::-webkit-scrollbar-track]:bg-transparent">
            {products.length === 0 ? (
              <p className="py-8 text-center text-xs text-slate-300">
                暂无产品，可手动添加或先用 CLI 导入产品列表
              </p>
            ) : (
              products.map((p) => (
                <div
                  key={p.id}
                  data-product-row
                  data-product-id={p.id}
                  className="flex items-center gap-2 rounded-lg px-2 py-1.5 transition-colors hover:bg-slate-50"
                >
                  <span className="w-20 shrink-0 font-mono text-[11px] tabular-nums text-slate-400">
                    {p.id}
                  </span>
                  {editingId === p.id ? (
                    <input
                      ref={editInputRef}
                      data-product-name-input
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      onBlur={commitEdit}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') commitEdit()
                        if (e.key === 'Escape') {
                          e.stopPropagation()
                          cancelEdit()
                        }
                      }}
                      className="min-w-0 flex-1 rounded-md border border-indigo-300 bg-white px-1.5 py-0.5 text-[13px] text-slate-700 focus:outline-none focus:ring-2 focus:ring-indigo-200"
                    />
                  ) : (
                    <span
                      data-product-name
                      onClick={() => startEdit(p)}
                      title="点击改名"
                      className="min-w-0 flex-1 cursor-text truncate rounded px-1.5 py-0.5 text-[13px] text-slate-700 transition-colors hover:bg-white"
                    >
                      {p.name}
                    </span>
                  )}
                  <span
                    data-product-usage
                    className="shrink-0 text-[11px] tabular-nums text-slate-400"
                  >
                    {usageOf(p.id)} 张
                  </span>
                  <button
                    type="button"
                    aria-label={`删除产品 ${p.id}`}
                    data-product-delete
                    title="删除（引用它的卡片将显示「不明」）"
                    onClick={() => onApply(products.filter((x) => x.id !== p.id))}
                    className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[13px] leading-none text-slate-300 transition-colors hover:bg-rose-100 hover:text-rose-600"
                  >
                    ×
                  </button>
                </div>
              ))
            )}
          </div>

          {/* 底部新增行（固定不滚） */}
          <div className="flex shrink-0 items-center gap-2 border-t border-slate-100 px-6 py-3">
            <input
              data-product-add-input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') addProduct()
              }}
              placeholder="新产品名称…（id 自动生成）"
              className="min-w-0 flex-1 rounded-md border border-slate-200 bg-white px-2 py-1.5 text-[13px] text-slate-700 focus:outline-none focus:ring-2 focus:ring-indigo-200"
            />
            <button
              type="button"
              data-product-add
              onClick={addProduct}
              disabled={!newName.trim()}
              className="shrink-0 rounded-lg bg-slate-900 px-3 py-1.5 text-[13px] text-white transition-colors hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-30"
            >
              添加
            </button>
          </div>
        </DialogPrimitive.Content>
      </DialogPortal>
    </Dialog>
  )
}
