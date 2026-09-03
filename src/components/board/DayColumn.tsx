import { memo } from 'react'
import { useDroppable } from '@dnd-kit/core'
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable'
import type { ContentItem } from '@/types/content'
import type { DayInfo } from '@/lib/content-data'
import SortableCard from './BoardCard'

interface DayColumnProps {
  day: DayInfo
  cards: ContentItem[] // 已按 orders 排序
  onOpenDetail: (id: string) => void
  onDelete: (id: string) => void
  onAddCard: (date: string) => void
  /** v16 容量上限：false 时「+ 空卡片」禁用 */
  canAdd: boolean
}

// v16：61 列常驻渲染，memo 避免拖拽/FAB 等无关状态变化引起全列重渲染
function DayColumn({
  day,
  cards,
  onOpenDetail,
  onDelete,
  onAddCard,
  canAdd,
}: DayColumnProps) {
  // 列容器本身 droppable，空列也可落
  const { setNodeRef, isOver } = useDroppable({
    id: `col-${day.date}`,
    data: { type: 'column', date: day.date },
  })

  return (
    <div data-date={day.date} className="flex w-[236px] shrink-0 flex-col">
      {/* 日列表头：sticky 在横向滚动容器顶部 */}
      <div className="sticky top-0 z-10 bg-[#f4f5f7] pb-2 pt-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5">
            <span
              className={`text-sm font-semibold tabular-nums ${
                day.isToday ? 'text-indigo-600' : 'text-slate-700'
              }`}
            >
              {day.monthDay}
            </span>
            <span className={`text-[11px] ${day.isToday ? 'text-indigo-500' : 'text-slate-400'}`}>
              {day.week}
            </span>
            {day.isToday && (
              <span className="rounded-full bg-indigo-500 px-1.5 py-px text-[10px] font-medium text-white">
                今天
              </span>
            )}
          </div>
          <span className="text-[11px] tabular-nums text-slate-400">{cards.length} 张</span>
        </div>
      </div>

      {/* 列容器：半透明白色圆角；周末极淡底色；拖拽悬停时整体高亮 */}
      <div
        ref={setNodeRef}
        className={[
          'relative flex min-h-[220px] flex-1 flex-col rounded-2xl border transition-colors duration-150',
          day.isToday
            ? 'border-indigo-200 bg-indigo-50/70'
            : day.isWeekend
              ? 'border-slate-200/70 bg-slate-100/60'
              : 'border-slate-200/70 bg-white/60',
          isOver ? 'border-indigo-300 bg-indigo-50/80 ring-2 ring-indigo-400/70' : '',
        ].join(' ')}
      >
        {/* 今天列顶部 accent 细线 */}
        {day.isToday && (
          <div className="absolute left-3 right-3 top-0 h-[3px] -translate-y-px rounded-full bg-indigo-500" />
        )}

        <SortableContext items={cards.map((c) => c.id)} strategy={verticalListSortingStrategy}>
          <div className="flex flex-1 flex-col gap-2 p-2.5">
            {cards.map((card) => (
              <SortableCard
                key={card.id}
                card={card}
                onOpenDetail={onOpenDetail}
                onDelete={onDelete}
              />
            ))}
            {cards.length === 0 && (
              <div className="flex flex-1 items-center justify-center rounded-xl border border-dashed border-slate-200 py-8 text-xs text-slate-300">
                拖到这里
              </div>
            )}
          </div>
        </SortableContext>

        {/* 新增空卡片（达容量上限时禁用） */}
        <div className="p-2.5 pt-0">
          <button
            type="button"
            disabled={!canAdd}
            title={canAdd ? undefined : '已达单板上限 2000 张，请按时间切片新建看板'}
            onClick={() => onAddCard(day.date)}
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

export default memo(DayColumn)
