import { useEffect, useRef, useState } from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { XIcon } from 'lucide-react'
import { Dialog, DialogOverlay, DialogPortal, DialogTitle } from '@/components/ui/dialog'
import type { ContentItem, Member } from '@/types/content'

interface MemberManagerDialogProps {
  open: boolean
  members: Member[]
  items: ContentItem[] // 使用计数（按 items 统计引用）
  onClose: () => void
  onApply: (next: Member[]) => void
}

/** 扫描现有 id 数字后缀取 max+1，格式 M-<四位>；无数字后缀 id 时从 M-1001 起 */
function nextMemberId(members: Member[]): string {
  let max = 1000
  for (const m of members) {
    const match = m.id.match(/(\d+)$/)
    if (match) max = Math.max(max, Number(match[1]))
  }
  return `M-${String(max + 1).padStart(4, '0')}`
}

/**
 * 成员管理弹窗（与产品管理弹窗完全同构）：
 * 每行 id + 姓名（inline 编辑）+ 使用计数（内容 N · 投放 M 分列）+ 删除 ×
 * （立即删除，引用卡片按设计降级「未分配」）；
 * 底部新增行（id 自动生成）；空目录占位。内置成员不特殊保护，可改可删。
 */
export default function MemberManagerDialog({
  open,
  members,
  items,
  onClose,
  onApply,
}: MemberManagerDialogProps) {
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

  const startEdit = (m: Member) => {
    setDraft(m.name)
    setEditingId(m.id)
  }
  const commitEdit = () => {
    if (!editingId) return
    const name = draft.trim()
    const target = members.find((m) => m.id === editingId)
    if (name && target && name !== target.name) {
      onApply(members.map((m) => (m.id === editingId ? { ...m, name } : m)))
    }
    // 空名拒绝保存：直接退出编辑态（不改数据）
    setEditingId(null)
  }
  const cancelEdit = () => setEditingId(null)

  const addMember = () => {
    const name = newName.trim()
    if (!name) return // 空名拒绝
    onApply([...members, { id: nextMemberId(members), name }])
    setNewName('')
  }

  const contentCount = (id: string) => items.filter((it) => it.content_owner_id === id).length
  const deliveryCount = (id: string) => items.filter((it) => it.delivery_owner_id === id).length

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogPortal>
        <DialogOverlay className="bg-slate-900/40 backdrop-blur-sm" />
        <DialogPrimitive.Content
          data-members-dialog
          onEscapeKeyDown={(e) => {
            // 姓名编辑态时 Esc 只取消编辑、不关弹窗（同 DetailDialog 拦截层级）
            if (editingId) e.preventDefault()
          }}
          className="data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 fixed left-[50%] top-[50%] z-50 flex max-h-[85vh] w-[calc(100vw-2rem)] max-w-lg translate-x-[-50%] translate-y-[-50%] flex-col overflow-hidden rounded-2xl border border-slate-200/80 bg-white/95 shadow-[0_24px_64px_-16px_rgba(15,23,42,0.35)] backdrop-blur duration-200 outline-none"
        >
          <DialogTitle className="sr-only">成员管理</DialogTitle>

          {/* 头部（固定不滚） */}
          <div className="flex shrink-0 items-center gap-2 border-b border-slate-100 px-6 pb-3 pt-4 shadow-[0_1px_3px_rgba(15,23,42,0.04)]">
            <h2 className="text-[15px] font-semibold text-slate-800">成员管理</h2>
            <span className="text-[11px] tabular-nums text-slate-400">{members.length} 人</span>
            <DialogPrimitive.Close
              aria-label="关闭成员管理"
              className="ml-auto flex h-6 w-6 items-center justify-center rounded-full text-slate-400 outline-none transition-colors hover:bg-slate-100 hover:text-slate-600 focus-visible:ring-2 focus-visible:ring-indigo-200"
            >
              <XIcon className="size-4" />
            </DialogPrimitive.Close>
          </div>

          {/* 列表（独立滚动） */}
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-2 [scrollbar-color:rgba(148,163,184,0.45)_transparent] [scrollbar-width:thin] [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-slate-300/50 [&::-webkit-scrollbar-track]:bg-transparent">
            {members.length === 0 ? (
              <p className="py-8 text-center text-xs text-slate-300">
                暂无成员，可手动添加或先用 CLI 导入负责人名单
              </p>
            ) : (
              members.map((m) => (
                <div
                  key={m.id}
                  data-member-row
                  data-member-id={m.id}
                  className="flex items-center gap-2 rounded-lg px-2 py-1.5 transition-colors hover:bg-slate-50"
                >
                  <span className="w-20 shrink-0 font-mono text-[11px] tabular-nums text-slate-400">
                    {m.id}
                  </span>
                  {editingId === m.id ? (
                    <input
                      ref={editInputRef}
                      data-member-name-input
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
                      data-member-name
                      onClick={() => startEdit(m)}
                      title="点击改名"
                      className="min-w-0 flex-1 cursor-text truncate rounded px-1.5 py-0.5 text-[13px] text-slate-700 transition-colors hover:bg-white"
                    >
                      {m.name}
                    </span>
                  )}
                  <span
                    data-member-usage
                    className="shrink-0 text-[11px] tabular-nums text-slate-400"
                  >
                    内容 {contentCount(m.id)} · 投放 {deliveryCount(m.id)}
                  </span>
                  <button
                    type="button"
                    aria-label={`删除成员 ${m.id}`}
                    data-member-delete
                    title="删除（引用它的卡片将显示「未分配」）"
                    onClick={() => onApply(members.filter((x) => x.id !== m.id))}
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
              data-member-add-input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') addMember()
              }}
              placeholder="新成员姓名…（id 自动生成）"
              className="min-w-0 flex-1 rounded-md border border-slate-200 bg-white px-2 py-1.5 text-[13px] text-slate-700 focus:outline-none focus:ring-2 focus:ring-indigo-200"
            />
            <button
              type="button"
              data-member-add
              onClick={addMember}
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
