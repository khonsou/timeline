/**
 * v2-M2 F3 统一分组模型：唯一看板列组件（GroupColumn）。
 *
 * 列 = [虚拟「未分组」列（key=''，恒第一，虚线视觉，不可删/改名/排序）] + groups[]。
 * 组名为 YYYY-MM-DD 的「日期组」列头复刻原 DayColumn 视觉（M/D + 周X + 今天徽章 +
 * 周末底色 + 今天 accent 线），并在根节点带 data-date=组名 —— 回到今天/键盘 ±7 天/
 * minimap 定位等日期选择器（scrollToDate）自然退化为「组名可解析为日期则工作」。
 * 根节点恒带 data-group-key=列 key（revealCard/列级定位用）。
 *
 * 真实组列表头 = grip 整列拖拽手柄（外层列排序 SortableContext）+ 名称
 * （点击进入行内编辑：Enter/失焦保存、Esc 取消，同 DetailDialog 备注编辑模式）+
 * 张数 + 删除 ×（确认框带组内卡片数，确认后卡片归「未分组」）。
 *
 * 碰撞判定复用 data.date 承载列 key（Board 组合式判定按 data.date 同列过滤）。
 */
import { memo, useEffect, useRef, useState } from 'react'
import { useDroppable } from '@dnd-kit/core'
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { GripVertical, X } from 'lucide-react'
import type { ContentItem } from '@timeline/core/types'
import { isDateGroupName } from '@timeline/core/group-core'
import { todayStr } from '@/lib/content-data'
import SortableCard from './BoardCard'

const WEEK = '日一二三四五六'

interface GroupColumnProps {
  /** 列 key：分组 id；'' = 虚拟「未分组」列 */
  colKey: string
  name: string
  cards: ContentItem[] // 已按 orders 排序
  onOpenDetail: (id: string) => void
  onDelete: (id: string) => void
  /** 新卡 publish_at 恒为今天；未分组列新建 = 无 group_id */
  onAddCard: (groupId?: string) => void
  /** v2-M1：卡片动作（背景色写 hex；null = 恢复默认） */
  onSetBgColor: (id: string, hex: string | null) => void
  onToggleDimmed: (id: string) => void
  onCopyShareLink: (id: string) => void
  /** F5/F6 定位一次性高亮的卡片 id */
  highlightId?: string | null
  /** v16 容量上限：false 时「+ 空卡片」禁用 */
  canAdd: boolean
  /** 行内改名（仅真实组列传入） */
  onRenameGroup?: (id: string, name: string) => void
  /** 删除分组（组内卡片归未分组，仅真实组列传入） */
  onDeleteGroup?: (id: string) => void
}

function GroupColumn({
  colKey,
  name,
  cards,
  onOpenDetail,
  onDelete,
  onAddCard,
  onSetBgColor,
  onToggleDimmed,
  onCopyShareLink,
  highlightId,
  canAdd,
  onRenameGroup,
  onDeleteGroup,
}: GroupColumnProps) {
  const ungrouped = colKey === ''
  const dateName = !ungrouped && isDateGroupName(name)
  // 日期组视觉参数（复刻 DayColumn）
  const dt = dateName
    ? (() => {
        const [y, m, d] = name.split('-').map(Number)
        return { monthDay: `${m}/${d}`, week: `周${WEEK[new Date(y, m - 1, d).getDay()]}`, day: new Date(y, m - 1, d).getDay() }
      })()
    : null
  const isToday = dateName && name === todayStr()
  const isWeekend = dt ? dt.day === 0 || dt.day === 6 : false

  // 列容器本身 droppable（卡片拖拽），空列也可落；data.date 承载列 key（组合式碰撞判定）
  const { setNodeRef: setDropRef, isOver } = useDroppable({
    id: `col-${colKey || 'ungrouped'}`,
    data: { type: 'column', date: colKey },
  })
  // 整列拖拽排序（外层 SortableContext，horizontal）；未分组列禁用
  const {
    attributes,
    listeners,
    setNodeRef: setSortRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: `gcol:${colKey}`,
    data: { type: 'group-column', groupId: colKey },
    disabled: ungrouped,
  })
  const setRefs = (el: HTMLDivElement | null) => {
    setSortRef(el)
  }

  // ------------------------------------------------------------------
  // 列头行内改名（参考 DetailDialog 备注编辑：点击进入编辑态，Enter/失焦保存，Esc 取消）
  // ------------------------------------------------------------------
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(name)
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (editing) inputRef.current?.select()
  }, [editing])
  const startEdit = () => {
    if (ungrouped || !onRenameGroup) return
    setDraft(name)
    setEditing(true)
  }
  const saveEdit = () => {
    const v = draft.trim()
    if (v && v !== name) onRenameGroup?.(colKey, v)
    setEditing(false)
  }
  const cancelEdit = () => setEditing(false)

  // 删除确认（内联气泡：带组内卡片数，确认后卡片归「未分组」）
  const [confirming, setConfirming] = useState(false)

  return (
    <div
      ref={setRefs}
      data-group-key={colKey}
      data-group-column={ungrouped ? 'ungrouped' : colKey}
      {...(dateName ? { 'data-date': name } : {})}
      style={{
        transform: CSS.Transform.toString(transform),
        transition: transition ?? undefined,
        opacity: isDragging ? 0.4 : undefined,
      }}
      className="relative flex w-[236px] shrink-0 flex-col"
    >
      {/* 列表头：sticky 在横向滚动容器顶部 */}
      <div className="sticky top-0 z-10 bg-[#f4f5f7] pb-2 pt-3">
        <div className="flex items-center justify-between gap-1">
          <div className="flex min-w-0 items-center gap-1">
            {/* grip 整列拖拽手柄（仅真实组列） */}
            {!ungrouped && (
              <button
                type="button"
                data-group-grip
                title="拖拽调整列顺序"
                {...attributes}
                {...listeners}
                className="shrink-0 cursor-grab touch-none rounded p-0.5 text-slate-300 transition-colors hover:text-slate-500 active:cursor-grabbing"
              >
                <GripVertical className="size-3.5" />
              </button>
            )}
            {editing ? (
              <input
                ref={inputRef}
                data-group-name-input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={saveEdit}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') saveEdit()
                  else if (e.key === 'Escape') cancelEdit()
                }}
                maxLength={40}
                className="w-32 rounded-md border border-indigo-300 bg-white px-1.5 py-0.5 text-sm font-semibold text-slate-700 focus:outline-none focus:ring-2 focus:ring-indigo-200"
              />
            ) : dateName && dt ? (
              <button
                type="button"
                data-group-name
                title="点击改名"
                onClick={startEdit}
                className="flex min-w-0 items-center gap-1.5 text-left"
              >
                <span
                  className={`text-sm font-semibold tabular-nums ${
                    isToday ? 'text-indigo-600' : 'text-slate-700'
                  }`}
                >
                  {dt.monthDay}
                </span>
                <span className={`text-[11px] ${isToday ? 'text-indigo-500' : 'text-slate-400'}`}>
                  {dt.week}
                </span>
                {isToday && (
                  <span className="rounded-full bg-indigo-500 px-1.5 py-px text-[10px] font-medium text-white">
                    今天
                  </span>
                )}
              </button>
            ) : (
              <button
                type="button"
                data-group-name
                title={ungrouped ? '未分组（系统列）：新建/拖入的卡片不带分组' : '点击改名'}
                onClick={startEdit}
                disabled={ungrouped}
                className={`truncate text-sm font-semibold ${
                  ungrouped ? 'cursor-default text-slate-400' : 'text-slate-700 hover:text-indigo-600'
                }`}
              >
                {name}
              </button>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <span className="text-[11px] tabular-nums text-slate-400">{cards.length} 张</span>
            {!ungrouped && onDeleteGroup && (
              <button
                type="button"
                data-group-delete
                title="删除分组（卡片移至未分组）"
                onClick={() => setConfirming(true)}
                className="flex h-4 w-4 items-center justify-center rounded-full text-slate-300 transition-colors hover:bg-rose-50 hover:text-rose-500"
              >
                <X className="size-3" />
              </button>
            )}
          </div>
        </div>

        {/* 删除确认气泡（带组内卡片数） */}
        {confirming && (
          <div
            data-group-delete-confirm
            className="absolute left-0 right-0 top-full z-30 mt-1 rounded-xl border border-slate-200 bg-white p-3 shadow-[0_12px_32px_-12px_rgba(15,23,42,0.35)]"
          >
            <p className="text-[12px] font-medium text-slate-700">删除分组「{name}」？</p>
            <p className="mt-1 text-[11px] text-slate-400" data-group-delete-count>
              组内 {cards.length} 张卡片将移至「未分组」
            </p>
            <div className="mt-2.5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirming(false)}
                className="rounded-lg px-2.5 py-1 text-[11px] text-slate-500 transition-colors hover:bg-slate-100"
              >
                取消
              </button>
              <button
                type="button"
                data-group-delete-ok
                onClick={() => {
                  setConfirming(false)
                  onDeleteGroup?.(colKey)
                }}
                className="rounded-lg bg-rose-500 px-2.5 py-1 text-[11px] font-medium text-white transition-colors hover:bg-rose-600"
              >
                删除
              </button>
            </div>
          </div>
        )}
      </div>

      {/* 列容器：未分组列虚线边框（系统列降级视觉）；日期组复刻 DayColumn 今天/周末底色；
          拖拽悬停整体高亮 */}
      <div
        ref={setDropRef}
        className={[
          'relative flex min-h-[220px] flex-1 flex-col rounded-2xl border transition-colors duration-150',
          ungrouped
            ? 'border-dashed border-slate-300/80 bg-slate-100/50'
            : isToday
              ? 'border-indigo-200 bg-indigo-50/70'
              : isWeekend
                ? 'border-slate-200/70 bg-slate-100/60'
                : 'border-slate-200/70 bg-white/60',
          isOver ? 'border-indigo-300 bg-indigo-50/80 ring-2 ring-indigo-400/70' : '',
        ].join(' ')}
      >
        {/* 今天列顶部 accent 细线 */}
        {isToday && (
          <div className="absolute left-3 right-3 top-0 h-[3px] -translate-y-px rounded-full bg-indigo-500" />
        )}

        <SortableContext items={cards.map((c) => c.id)} strategy={verticalListSortingStrategy}>
          <div className="flex flex-1 flex-col gap-2 p-2.5">
            {cards.map((card) => (
              <SortableCard
                key={card.id}
                card={card}
                colKey={colKey}
                onOpenDetail={onOpenDetail}
                onDelete={onDelete}
                onSetBgColor={onSetBgColor}
                onToggleDimmed={onToggleDimmed}
                onCopyShareLink={onCopyShareLink}
                highlighted={card.id === highlightId}
              />
            ))}
            {cards.length === 0 && (
              <div className="flex flex-1 items-center justify-center rounded-xl border border-dashed border-slate-200 py-8 text-xs text-slate-300">
                拖到这里
              </div>
            )}
          </div>
        </SortableContext>

        {/* 新增空卡片（达容量上限时禁用）；新卡 publish_at = 今天 */}
        <div className="p-2.5 pt-0">
          <button
            type="button"
            disabled={!canAdd}
            title={canAdd ? undefined : '已达单板上限 2000 张，请按时间切片新建看板'}
            onClick={() => onAddCard(ungrouped ? undefined : colKey)}
            className={
              canAdd
                ? 'w-full rounded-xl border border-dashed border-slate-300 py-2 text-xs text-slate-400 transition-colors duration-150 hover:border-indigo-300 hover:bg-white/70 hover:text-indigo-500'
                : 'w-full cursor-not-allowed rounded-xl border border-dashed border-slate-200 py-2 text-xs text-slate-300'
            }
          >
            + 空卡片
          </button>
        </div>
      </div>
    </div>
  )
}

export default memo(GroupColumn)
