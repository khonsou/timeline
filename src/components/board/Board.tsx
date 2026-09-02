import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCorners,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from '@dnd-kit/core'
import type { ContentItem } from '@/types/content'
import { buildDays, todayStr } from '@/lib/content-data'
import { cardsInDay, publishDateOf, publishTimeOf, type Orders } from '@/lib/board-view'
import DayColumn from './DayColumn'
import { OverlayCard } from './BoardCard'

export interface BoardApi {
  scrollToToday: (behavior?: ScrollBehavior) => void
}

interface BoardProps {
  items: ContentItem[]
  orders: Orders
  setItems: React.Dispatch<React.SetStateAction<ContentItem[]>>
  setOrders: React.Dispatch<React.SetStateAction<Orders>>
  editingCardId: string | null
  onEditEnd: () => void
  onUpdate: (id: string, patch: Partial<ContentItem>) => void
  onDelete: (id: string) => void
  onAddCard: (date: string) => void
  apiRef: React.MutableRefObject<BoardApi | null>
}

const COLUMN_STEP = 236 + 12 // 列宽 + 间距

export default function Board({
  items,
  orders,
  setItems,
  setOrders,
  editingCardId,
  onEditEnd,
  onUpdate,
  onDelete,
  onAddCard,
  apiRef,
}: BoardProps) {
  const [activeId, setActiveId] = useState<string | null>(null)
  const [fab, setFab] = useState<{ dir: 'left' | 'right' } | null>(null)
  const snapshotRef = useRef<{ items: ContentItem[]; orders: Orders } | null>(null)
  const scrollerRef = useRef<HTMLDivElement>(null)
  const days = buildDays()
  const TODAY = todayStr()

  // 与 inline 编辑共存：移动 8px 才触发拖拽，点击不触发
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
  )

  const activeCard = activeId ? items.find((c) => c.id === activeId) : undefined

  // ------------------------------------------------------------------
  // 定位到今天：edge = 首屏（左侧留一列余量，instant）；center = 手动（中央偏左，smooth）
  // ------------------------------------------------------------------
  const scrollToToday = useCallback(
    (behavior: ScrollBehavior = 'smooth', mode: 'edge' | 'center' = 'center') => {
      const scroller = scrollerRef.current
      if (!scroller) return
      const col = scroller.querySelector<HTMLElement>(`[data-date="${TODAY}"]`)
      if (!col) return
      const sRect = scroller.getBoundingClientRect()
      const cRect = col.getBoundingClientRect()
      const x = cRect.left - sRect.left + scroller.scrollLeft
      const max = Math.max(0, scroller.scrollWidth - scroller.clientWidth)
      const target =
        mode === 'edge'
          ? x - COLUMN_STEP
          : x - scroller.clientWidth / 2 + cRect.width / 2 - 60
      scroller.scrollTo({ left: Math.max(0, Math.min(max, target)), behavior })
    },
    [TODAY],
  )

  // 首屏挂载后立即定位（instant，避免开场动画）
  const didInitScroll = useRef(false)
  useLayoutEffect(() => {
    if (didInitScroll.current) return
    didInitScroll.current = true
    scrollToToday('auto', 'edge')
  }, [scrollToToday])

  // 暴露给顶栏「回到今天」按钮
  useEffect(() => {
    apiRef.current = { scrollToToday: (behavior = 'smooth') => scrollToToday(behavior, 'center') }
    return () => {
      apiRef.current = null
    }
  }, [apiRef, scrollToToday])

  // IntersectionObserver：今天列不在视口内时显示 FAB，并给出方向提示
  useEffect(() => {
    const scroller = scrollerRef.current
    if (!scroller) return
    const col = scroller.querySelector<HTMLElement>(`[data-date="${TODAY}"]`)
    if (!col) return
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setFab(null)
        } else {
          const sRect = scroller.getBoundingClientRect()
          setFab({ dir: entry.boundingClientRect.left < sRect.left ? 'left' : 'right' })
        }
      },
      { root: scroller, threshold: 0.15 },
    )
    observer.observe(col)
    return () => observer.disconnect()
  }, [TODAY])

  // ------------------------------------------------------------------
  // 拖拽（autoScroll 保持 dnd-kit 默认开启，拖到左右边缘自动横滚）
  // 跨日拖拽：更新 publish_at 的日期部分、保留时分（数据层语义变更）
  // 同列排序：只动 orders（不碰实体）
  // ------------------------------------------------------------------
  const handleDragStart = (e: DragStartEvent) => {
    snapshotRef.current = { items, orders }
    setActiveId(String(e.active.id))
  }

  // 跨列乐观插入：给拖拽卡片一个位于邻居之间的 order，间隙不足时先归一化
  const handleDragOver = (e: DragOverEvent) => {
    const { active, over } = e
    if (!over) return
    const overDate = over.data.current?.date as string | undefined
    if (overDate === undefined) return

    const dragging = items.find((c) => c.id === active.id)
    if (!dragging) return
    if (publishDateOf(dragging) === overDate) return // 同列由 sortable 动画表达

    const col = cardsInDay(items, orders, overDate)
    let index = col.length
    if (over.data.current?.type === 'card') {
      const i = col.findIndex((c) => c.id === over.id)
      if (i >= 0) index = i
    }

    // 数据层：publish_at 只改日期部分，保留时分
    setItems((prev) =>
      prev.map((c) =>
        c.id === active.id ? { ...c, publish_at: `${overDate}T${publishTimeOf(c)}` } : c,
      ),
    )

    // 视图层：orders 中点插入；间隙不足时连同插入位置对目标列归一化
    const lo = index > 0 ? (orders[col[index - 1].id] ?? 0) : null
    const hi = index < col.length ? (orders[col[index].id] ?? 0) : null
    if (lo !== null && hi !== null && hi - lo <= 1e-6) {
      const reordered = [...col.slice(0, index), dragging, ...col.slice(index)]
      const patch = Object.fromEntries(reordered.map((c, i) => [c.id, i]))
      setOrders((prev) => ({ ...prev, ...patch }))
    } else {
      const order = lo === null ? (hi ?? 1) - 1 : hi === null ? lo + 1 : (lo + hi) / 2
      setOrders((prev) => ({ ...prev, [dragging.id]: order }))
    }
  }

  // 落定：计算插入索引，对受影响列做 orders 归一化（order = 0,1,2…）
  const handleDragEnd = (e: DragEndEvent) => {
    const { active, over } = e
    setActiveId(null)
    snapshotRef.current = null
    if (!over || over.id === active.id) return
    const overDate = over.data.current?.date as string | undefined
    if (overDate === undefined) return

    const dragging = items.find((c) => c.id === active.id)
    if (!dragging) return

    // 跨日拖拽但 dragOver 未覆盖到的兜底：落定前确保日期部分已切换
    if (publishDateOf(dragging) !== overDate) {
      setItems((prev) =>
        prev.map((c) =>
          c.id === active.id ? { ...c, publish_at: `${overDate}T${publishTimeOf(c)}` } : c,
        ),
      )
    }

    const col = cardsInDay(items, orders, overDate).filter((c) => c.id !== active.id)
    let index = col.length
    if (over.data.current?.type === 'card') {
      const i = col.findIndex((c) => c.id === over.id)
      if (i >= 0) index = i
    }
    const reordered = [...col.slice(0, index), dragging, ...col.slice(index)]
    const patch = Object.fromEntries(reordered.map((c, i) => [c.id, i]))
    setOrders((prev) => ({ ...prev, ...patch }))
  }

  const handleDragCancel = () => {
    if (snapshotRef.current) {
      setItems(snapshotRef.current.items)
      setOrders(snapshotRef.current.orders)
    }
    snapshotRef.current = null
    setActiveId(null)
  }

  return (
    <div className="relative min-h-0 flex-1">
      <DndContext
        sensors={sensors}
        collisionDetection={closestCorners}
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDragEnd={handleDragEnd}
        onDragCancel={handleDragCancel}
      >
        {/* 看板区域：横向 + 纵向滚动 */}
        <div ref={scrollerRef} className="h-full overflow-auto">
          <div className="flex w-max items-stretch gap-3 px-4 pb-5">
            {days.map((day) => (
              <DayColumn
                key={day.date}
                day={day}
                cards={cardsInDay(items, orders, day.date)}
                editingCardId={editingCardId}
                onEditEnd={onEditEnd}
                onUpdate={onUpdate}
                onDelete={onDelete}
                onAddCard={onAddCard}
              />
            ))}
          </div>
        </div>

        <DragOverlay dropAnimation={{ duration: 180 }}>
          {activeCard ? <OverlayCard card={activeCard} /> : null}
        </DragOverlay>
      </DndContext>

      {/* 回到今天 FAB：今天列不在视口内时才显示，箭头指向今天列方向 */}
      {fab && (
        <button
          type="button"
          onClick={() => scrollToToday('smooth', 'center')}
          className="absolute bottom-5 right-5 z-30 flex items-center gap-1.5 rounded-full border border-slate-200 bg-white/95 px-4 py-2 text-sm font-medium text-slate-700 shadow-[0_10px_28px_-10px_rgba(15,23,42,0.35)] backdrop-blur transition-all duration-150 hover:-translate-y-px hover:border-indigo-300 hover:text-indigo-600"
        >
          <span className="text-indigo-500">{fab.dir === 'left' ? '←' : '→'}</span>
          回到今天
        </button>
      )}
    </div>
  )
}
