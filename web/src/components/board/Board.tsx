import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
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
import type { ContentItem } from '@timeline/core/types'
import {
  WINDOW_DAYS,
  WINDOW_RADIUS,
  addDays,
  buildWindowDays,
  dayDiff,
  todayStr,
} from '@/lib/content-data'
import { cardsInDay, publishDateOf, publishTimeOf, type Orders } from '@timeline/core/board-view'
import DayColumn from './DayColumn'
import BoardMinimap from './BoardMinimap'
import { OverlayCard } from './BoardCard'

export interface BoardApi {
  scrollToToday: (behavior?: ScrollBehavior) => void
  /** v16 B2：详情页把 publish_at 改出当前窗口时，视野跟随到新日期 */
  revealDate: (date: string) => void
}

interface BoardProps {
  items: ContentItem[]
  orders: Orders
  setItems: React.Dispatch<React.SetStateAction<ContentItem[]>>
  setOrders: React.Dispatch<React.SetStateAction<Orders>>
  onOpenDetail: (id: string) => void
  onDelete: (id: string) => void
  onAddCard: (date: string) => void
  apiRef: React.MutableRefObject<BoardApi | null>
  /** v16 容量上限：false 时禁用各列「+ 空卡片」 */
  canAdd: boolean
}

const COLUMN_STEP = 236 + 12 // 列宽 + 间距
const SIDE_PADDING = 16 // 内层容器 px-4
const HALF_COL = 236 / 2
/** 视口中线日期偏离窗口中心超过该天数 → 窗口整体滑动重建 */
const SLIDE_THRESHOLD = 10
/** 空列共享的空数组（稳定引用，配合 DayColumn memo） */
const EMPTY_CARDS: ContentItem[] = []

/**
 * v16 滑动窗口看板：恒定渲染 centerDate ±30 天共 61 列（不再随数据扩列）。
 * - 滚动时实时计算视口中线日期；偏离中心 >10 天 → setCenter 滑动窗口；
 *   useLayoutEffect 按滑动天数 × COLUMN_STEP 补偿 scrollLeft，内容视觉无跳。
 * - 日期跳转统一走 pendingJump：窗口外目标先 setCenter 重建，布局阶段再定位。
 * - 拖拽期间禁用窗口滑动（落点天然限于窗口内，A2 稳方案）。
 */
export default function Board({
  items,
  orders,
  setItems,
  setOrders,
  onOpenDetail,
  onDelete,
  onAddCard,
  apiRef,
  canAdd,
}: BoardProps) {
  const [activeId, setActiveId] = useState<string | null>(null)
  const [fab, setFab] = useState<{ dir: 'left' | 'right' } | null>(null)
  const snapshotRef = useRef<{ items: ContentItem[]; orders: Orders } | null>(null)
  const scrollerRef = useRef<HTMLDivElement>(null)
  // 拖拽结束后抑制紧随其后的 click，避免误开详情弹窗
  const suppressClickRef = useRef(false)

  const TODAY = todayStr()
  const [center, setCenter] = useState(TODAY)
  const centerRef = useRef(center)
  const prevCenterRef = useRef(center)
  const activeIdRef = useRef<string | null>(null)
  // 窗口外跳转：setCenter 后由布局效应消费（先补偿，再定位到目标列）
  const pendingJumpRef = useRef<{
    date: string
    mode: 'edge' | 'center'
    behavior: ScrollBehavior
  } | null>({ date: TODAY, mode: 'edge', behavior: 'auto' }) // 初始值兼作首屏定位

  const days = useMemo(() => buildWindowDays(center), [center])
  // ref 镜像统一在 effect 里同步（react-hooks/refs：render 期不写 ref）；
  // 读取方（jumpTo/滚动回调/键盘）都是事件处理器，一定发生在 effect 之后
  useEffect(() => {
    centerRef.current = center
  }, [center])

  // 全列预分组：O(N) 一次扫描 + 列内稳定排序（orders 升序，同序按原数组索引）
  const grouped = useMemo(() => {
    const inWindow = new Set(days.map((d) => d.date))
    const buckets = new Map<string, { c: ContentItem; i: number }[]>()
    items.forEach((c, i) => {
      const d = publishDateOf(c)
      if (!inWindow.has(d)) return
      const arr = buckets.get(d)
      if (arr) arr.push({ c, i })
      else buckets.set(d, [{ c, i }])
    })
    const out = new Map<string, ContentItem[]>()
    for (const [d, arr] of buckets) {
      arr.sort((a, b) => (orders[a.c.id] ?? 0) - (orders[b.c.id] ?? 0) || a.i - b.i)
      out.set(
        d,
        arr.map((x) => x.c),
      )
    }
    return out
  }, [items, orders, days])

  // 与 inline 编辑共存：移动 8px 才触发拖拽，点击不触发
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
  )

  const activeCard = activeId ? items.find((c) => c.id === activeId) : undefined

  // ------------------------------------------------------------------
  // 定位：edge = 左侧留一列余量；center = 居中偏左（-60px）
  // ------------------------------------------------------------------
  const scrollToDate = useCallback(
    (date: string, behavior: ScrollBehavior = 'smooth', mode: 'edge' | 'center' = 'center') => {
      const scroller = scrollerRef.current
      if (!scroller) return
      const col = scroller.querySelector<HTMLElement>(`[data-date="${date}"]`)
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
    [],
  )

  /**
   * 日期跳转统一入口。偏离 ≤SLIDE_THRESHOLD 直接平滑滚动（全程中线不越阈值，不会触发滑动）；
   * 超过阈值一律 pendingJump + setCenter 重建窗口，布局阶段瞬时定位（auto）——
   * 跨窗口不做平滑滚动：动画途中中线偏离超阈值会被滑动补偿截断（永远滚不到）。
   */
  const jumpTo = useCallback(
    (date: string, behavior: ScrollBehavior = 'smooth', mode: 'edge' | 'center' = 'center') => {
      const c = centerRef.current
      if (Math.abs(dayDiff(date, c)) <= SLIDE_THRESHOLD) {
        scrollToDate(date, behavior, mode)
        return
      }
      if (date === c) return
      pendingJumpRef.current = { date, mode, behavior: 'auto' }
      setCenter(date)
    },
    [scrollToDate],
  )

  const scrollToToday = useCallback(
    (behavior: ScrollBehavior = 'smooth', mode: 'edge' | 'center' = 'center') => {
      jumpTo(TODAY, behavior, mode)
    },
    [jumpTo, TODAY],
  )

  // 窗口滑动补偿 + 消费 pendingJump：每次渲染后、绘制前同步执行。
  // 补偿方向：center 向未来滑 slid 天 → 同一日期在新窗口的列位置左移 slid 列
  // → scrollLeft 减 slid × COLUMN_STEP，屏幕内容保持不动。
  useLayoutEffect(() => {
    const scroller = scrollerRef.current
    if (!scroller) return
    const prev = prevCenterRef.current
    if (prev !== center) {
      const slid = dayDiff(center, prev)
      scroller.scrollLeft -= slid * COLUMN_STEP
      prevCenterRef.current = center
    }
    const jump = pendingJumpRef.current
    if (jump) {
      pendingJumpRef.current = null
      scrollToDate(jump.date, jump.behavior, jump.mode)
    }
  })

  // 暴露给顶栏「回到今天」与详情页 B2 跟随
  useEffect(() => {
    apiRef.current = {
      scrollToToday: (behavior = 'smooth') => scrollToToday(behavior, 'center'),
      revealDate: (date) => jumpTo(date, 'smooth'),
    }
    return () => {
      apiRef.current = null
    }
  }, [apiRef, scrollToToday, jumpTo])

  // ------------------------------------------------------------------
  // 滚动 → 视口中线日期 → 偏离中心 >10 天则滑动窗口（rAF 节流；拖拽中禁用）
  // ------------------------------------------------------------------
  const scrollRafRef = useRef(0)
  const handleScroll = useCallback(() => {
    if (scrollRafRef.current) return
    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRafRef.current = 0
      if (activeIdRef.current) return // A2：拖拽期间禁用窗口滑动
      const scroller = scrollerRef.current
      if (!scroller) return
      const idx = Math.round(
        (scroller.scrollLeft + scroller.clientWidth / 2 - SIDE_PADDING - HALF_COL) / COLUMN_STEP,
      )
      const clamped = Math.max(0, Math.min(WINDOW_DAYS - 1, idx))
      const midDate = days[clamped]?.date
      if (!midDate) return
      if (Math.abs(dayDiff(midDate, centerRef.current)) > SLIDE_THRESHOLD) {
        setCenter(midDate)
      }
    })
  }, [days])
  useEffect(
    () => () => {
      if (scrollRafRef.current) cancelAnimationFrame(scrollRafRef.current)
    },
    [],
  )

  // IntersectionObserver：今天列不在视口内时显示 FAB，并给出方向提示；
  // 今天不在窗口内（无 DOM 列）时不挂 observer，FAB 在渲染期按相对方向派生
  const todayInWindow = Math.abs(dayDiff(TODAY, center)) <= WINDOW_RADIUS
  useEffect(() => {
    const scroller = scrollerRef.current
    if (!scroller || !todayInWindow) return
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
  }, [TODAY, days, todayInWindow])
  const fabShown = todayInWindow
    ? fab
    : ({ dir: dayDiff(TODAY, center) < 0 ? 'left' : 'right' } as const)

  // ------------------------------------------------------------------
  // 键盘导航：T 回今天；←/→ ±7 天；Shift+←/→ ±30 天；输入框聚焦不触发
  // 步进基准 = 视口中线日期（用户视角位置），不是 center——未触发滑动时两者会偏离
  // ------------------------------------------------------------------
  const daysRef = useRef(days)
  useEffect(() => {
    daysRef.current = days
  }, [days])
  useEffect(() => {
    const midlineDate = (): string => {
      const scroller = scrollerRef.current
      const ds = daysRef.current
      if (!scroller || !ds.length) return centerRef.current
      const idx = Math.round(
        (scroller.scrollLeft + scroller.clientWidth / 2 - SIDE_PADDING - HALF_COL) / COLUMN_STEP,
      )
      return ds[Math.max(0, Math.min(ds.length - 1, idx))]?.date ?? centerRef.current
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const t = e.target as HTMLElement | null
      if (
        t &&
        (t.tagName === 'INPUT' ||
          t.tagName === 'TEXTAREA' ||
          t.tagName === 'SELECT' ||
          t.isContentEditable)
      )
        return
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault()
        const step = e.shiftKey ? 30 : 7
        jumpTo(addDays(midlineDate(), e.key === 'ArrowRight' ? step : -step), 'smooth')
      } else if (e.key === 't' || e.key === 'T') {
        jumpTo(TODAY, 'smooth')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [jumpTo, TODAY])

  // ------------------------------------------------------------------
  // 拖拽（autoScroll 保持 dnd-kit 默认开启，拖到左右边缘自动横滚；
  // 滚动处理器在拖拽中不滑动窗口，落点天然限于当前窗口内）
  // 跨日拖拽：更新 publish_at 的日期部分、保留时分（数据层语义变更）
  // 同列排序：只动 orders（不碰实体）
  // ------------------------------------------------------------------
  // 拖拽落定/取消后：click 事件紧跟 pointerup 同步触发，之后解除抑制
  const suppressTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const scheduleSuppressReset = () => {
    if (suppressTimer.current) clearTimeout(suppressTimer.current)
    suppressTimer.current = setTimeout(() => {
      suppressClickRef.current = false
    }, 150)
  }

  const handleDragStart = (e: DragStartEvent) => {
    snapshotRef.current = { items, orders }
    suppressClickRef.current = true // 拖拽期间发生的 click 一律抑制
    const id = String(e.active.id)
    activeIdRef.current = id
    setActiveId(id)
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
    activeIdRef.current = null
    setActiveId(null)
    snapshotRef.current = null
    scheduleSuppressReset()
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
    activeIdRef.current = null
    setActiveId(null)
    scheduleSuppressReset()
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
        {/* 看板区域：横向 + 纵向滚动；capture 阶段吞掉拖拽后的误触 click；
            pb-20 给底部 minimap 让位 */}
        <div
          ref={scrollerRef}
          className="h-full overflow-auto"
          onScroll={handleScroll}
          onClickCapture={(e) => {
            if (suppressClickRef.current) {
              suppressClickRef.current = false
              e.stopPropagation()
              e.preventDefault()
            }
          }}
        >
          <div className="flex w-max items-stretch gap-3 px-4 pb-20">
            {days.map((day) => (
              <DayColumn
                key={day.date}
                day={day}
                cards={grouped.get(day.date) ?? EMPTY_CARDS}
                onOpenDetail={onOpenDetail}
                onDelete={onDelete}
                onAddCard={onAddCard}
                canAdd={canAdd}
              />
            ))}
          </div>
        </div>

        <DragOverlay dropAnimation={{ duration: 180 }}>
          {activeCard ? <OverlayCard card={activeCard} /> : null}
        </DragOverlay>
      </DndContext>

      {/* v16 minimap：全跨度密度热力 + 月刻度 + 今天线 + 窗口框（可拖/可点） */}
      <BoardMinimap
        items={items}
        center={center}
        scrollerRef={scrollerRef}
        onScrub={(date) => jumpTo(date, 'auto')}
      />

      {/* 回到今天 FAB：今天列不在视口内时才显示，箭头指向今天列方向 */}
      {fabShown && (
        <button
          type="button"
          onClick={() => scrollToToday('smooth', 'center')}
          className="absolute bottom-16 right-5 z-30 flex items-center gap-1.5 rounded-full border border-slate-200 bg-white/95 px-4 py-2 text-sm font-medium text-slate-700 shadow-[0_10px_28px_-10px_rgba(15,23,42,0.35)] backdrop-blur transition-all duration-150 hover:-translate-y-px hover:border-indigo-300 hover:text-indigo-600"
        >
          <span className="text-indigo-500">{fabShown.dir === 'left' ? '←' : '→'}</span>
          回到今天
        </button>
      )}
    </div>
  )
}
