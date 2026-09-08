import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCorners,
  pointerWithin,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from '@dnd-kit/core'
import { SortableContext, horizontalListSortingStrategy } from '@dnd-kit/sortable'
import type { ContentItem, Group } from '@timeline/core/types'
import { MAX_GROUPS } from '@timeline/core/types'
import { addDays, todayStr } from '@/lib/content-data'
import {
  cardsInColumn,
  columnKeyOf,
  type Orders,
} from '@timeline/core/board-view'
import GroupColumn from './GroupColumn'
import BoardMinimap from './BoardMinimap'
import { OverlayCard } from './BoardCard'

export interface BoardApi {
  scrollToToday: (behavior?: ScrollBehavior) => void
  /**
   * v2-M1（F5/F6 共用定位机制）：定位并一次性高亮指定卡片。
   * 全列常驻渲染（无滑动窗口），直接滚动到卡片所在分组列（'' = 未分组列）；
   * 高亮只播一次（约 1.8s 淡入淡出，不循环闪）。
   */
  revealCard: (id: string) => void
  /** 详情页改期跟随：直接滚到指定列（key = 分组 id / '' 未分组），不依赖卡片当前归属 */
  revealColumn: (key: string) => void
}

interface BoardProps {
  items: ContentItem[]
  orders: Orders
  setItems: React.Dispatch<React.SetStateAction<ContentItem[]>>
  setOrders: React.Dispatch<React.SetStateAction<Orders>>
  onOpenDetail: (id: string) => void
  onDelete: (id: string) => void
  /** 新卡 publish_at 恒为今天；groupId 省略 = 未分组列新建 */
  onAddCard: (groupId?: string) => void
  apiRef: React.MutableRefObject<BoardApi | null>
  /** v2-M1：卡片动作（背景色写 hex；null = 恢复默认） */
  onSetBgColor: (id: string, hex: string | null) => void
  onToggleDimmed: (id: string) => void
  onCopyShareLink: (id: string) => void
  /** v16 容量上限：false 时禁用各列「+ 空卡片」 */
  canAdd: boolean
  /** v2-M2 F3 统一分组模型：分组集合（数组序 = 列顺序）与管理动作 */
  groups?: Group[]
  onRenameGroup?: (id: string, name: string) => void
  /** 整列拖拽排序：把 id 移到 beforeId 之前（beforeId = null → 末尾） */
  onMoveGroup?: (id: string, beforeId: string | null) => void
  /** 删除分组（组内卡片归未分组） */
  onDeleteGroup?: (id: string) => void
  /** 末尾「+ 新建分组」（满 61 禁用） */
  onAddGroup?: () => void
}

const COLUMN_STEP = 236 + 12 // 列宽 + 间距
const SIDE_PADDING = 16 // 内层容器 px-4
const HALF_COL = 236 / 2
/** 空列共享的空数组（稳定引用，配合 GroupColumn memo） */
const EMPTY_CARDS: ContentItem[] = []

/**
 * v2-M2 F3 统一分组模型看板：
 * - 列 = [虚拟「未分组」列（恒第一）] + groups[]（≤61，全量常驻渲染）；
 *   滑动窗口机制退役（无 center 滑动 / scrollLeft 补偿）。
 * - 组名为 YYYY-MM-DD 的列带 data-date=组名：回到今天 / 键盘 ±7 天 / minimap
 *   scrub 定位自然退化为「组名可解析为日期则工作，否则无操作」。
 * - 单一 DndContext 承载两类拖拽：卡片（跨列移动 = 改 group_id；同列 = orders 排序）
 *   与组列排序（列头 grip 手柄，horizontalListSortingStrategy）。
 * - minimap 代码零改动，center 恒传 TODAY（dim 遮罩 = 今天 ±30 天外，与迁移窗口对齐）。
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
  onSetBgColor,
  onToggleDimmed,
  onCopyShareLink,
  canAdd,
  groups = [],
  onRenameGroup,
  onMoveGroup,
  onDeleteGroup,
  onAddGroup,
}: BoardProps) {
  const [activeId, setActiveId] = useState<string | null>(null)
  /** 列拖拽中的分组 id（DragOverlay 预览用；与 activeId 互斥） */
  const [activeGroupId, setActiveGroupId] = useState<string | null>(null)
  const [fab, setFab] = useState<{ dir: 'left' | 'right' } | null>(null)
  const snapshotRef = useRef<{ items: ContentItem[]; orders: Orders } | null>(null)
  const scrollerRef = useRef<HTMLDivElement>(null)
  const rowRef = useRef<HTMLDivElement>(null)
  // 拖拽结束后抑制紧随其后的 click，避免误开详情弹窗
  const suppressClickRef = useRef(false)

  const TODAY = todayStr()
  // 列定义：虚拟「未分组」列恒第一 + groups 数组序
  const columns = useMemo(
    () => [{ key: '', name: '未分组' }, ...groups.map((g) => ({ key: g.id, name: g.name }))],
    [groups],
  )

  /** 拖拽源列 key（碰撞判定用：非源列时排除拖拽卡自身，保住目标列高亮） */
  const dragSourceKeyRef = useRef<string | null>(null)
  const activeIdRef = useRef<string | null>(null)

  // 全列预分组：O(N) 一次扫描 + 列内稳定排序（orders 升序，同序按原数组索引）
  const grouped = useMemo(() => {
    const buckets = new Map<string, { c: ContentItem; i: number }[]>()
    items.forEach((c, i) => {
      const key = columnKeyOf(c)
      const arr = buckets.get(key)
      if (arr) arr.push({ c, i })
      else buckets.set(key, [{ c, i }])
    })
    const out = new Map<string, ContentItem[]>()
    for (const [key, arr] of buckets) {
      arr.sort((a, b) => (orders[a.c.id] ?? 0) - (orders[b.c.id] ?? 0) || a.i - b.i)
      out.set(
        key,
        arr.map((x) => x.c),
      )
    }
    return out
  }, [items, orders])

  // 与 inline 编辑共存：移动 8px 才触发拖拽，点击不触发
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
  )

  const activeCard = activeId ? items.find((c) => c.id === activeId) : undefined
  const activeGroup = activeGroupId ? groups.find((g) => g.id === activeGroupId) : undefined

  // ------------------------------------------------------------------
  // 定位：按选择器找列元素滚动到位。
  // scrollToDate 用 data-date（仅日期组列有）；scrollToColumn 用 data-group-key（全列有）。
  // edge = 左侧留一列余量；center = 居中偏左（-60px）
  // ------------------------------------------------------------------
  const scrollToSelector = useCallback(
    (selector: string, behavior: ScrollBehavior = 'smooth', mode: 'edge' | 'center' = 'center') => {
      const scroller = scrollerRef.current
      if (!scroller) return
      const col = scroller.querySelector<HTMLElement>(selector)
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
  const scrollToDate = useCallback(
    (date: string, behavior: ScrollBehavior = 'smooth', mode: 'edge' | 'center' = 'center') =>
      scrollToSelector(`[data-date="${date}"]`, behavior, mode),
    [scrollToSelector],
  )
  const scrollToColumn = useCallback(
    (key: string, behavior: ScrollBehavior = 'smooth', mode: 'edge' | 'center' = 'center') =>
      scrollToSelector(`[data-group-key="${key}"]`, behavior, mode),
    [scrollToSelector],
  )

  const scrollToToday = useCallback(
    (behavior: ScrollBehavior = 'smooth', mode: 'edge' | 'center' = 'center') => {
      scrollToDate(TODAY, behavior, mode)
    },
    [scrollToDate, TODAY],
  )

  // 首屏定位：今天列（无同名日期组时留在最左）。
  // groups 经同步层异步到达——闸门以「今天列真实出现在 DOM」为准，而非挂载即消费
  const didInitRef = useRef(false)
  useLayoutEffect(() => {
    if (didInitRef.current) return
    if (!scrollerRef.current?.querySelector(`[data-date="${TODAY}"]`)) return
    didInitRef.current = true
    scrollToDate(TODAY, 'auto', 'edge')
  }, [scrollToDate, TODAY, groups])

  // ------------------------------------------------------------------
  // v2-M1 卡片定位 + 一次性高亮（F5 搜索结果 / F6 分享链接共用）：
  // revealCard 只负责「高亮谁 + 把视口挪到卡片所在列」；消费 effect 在卡片
  // 进入 DOM 后滚入视口并启动撤除计时。高亮只播一次（HIGHLIGHT_MS 后撤掉）。
  // ------------------------------------------------------------------
  const HIGHLIGHT_MS = 1800
  const [highlightId, setHighlightId] = useState<string | null>(null)
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const itemsRef = useRef(items)
  useEffect(() => {
    itemsRef.current = items
  }, [items])

  const revealCard = useCallback(
    (id: string) => {
      const card = itemsRef.current.find((c) => c.id === id)
      if (!card) return
      if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current)
      setHighlightId(id)
      scrollToColumn(card.group_id ?? '', 'smooth', 'center')
    },
    [scrollToColumn],
  )

  // 消费高亮：找到后纵向滚入视口（横向已由 scrollToColumn 定位）并启动撤除计时
  useEffect(() => {
    if (!highlightId) return
    const el = scrollerRef.current?.querySelector(`[data-card-id="${highlightId}"]`)
    if (!el) return
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current)
    highlightTimerRef.current = setTimeout(() => setHighlightId(null), HIGHLIGHT_MS)
  }, [highlightId, columns])
  useEffect(
    () => () => {
      if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current)
    },
    [],
  )

  // 暴露给顶栏「回到今天」与 v2-M1 搜索/分享定位、详情页改期跟随
  useEffect(() => {
    apiRef.current = {
      scrollToToday: (behavior = 'smooth') => scrollToToday(behavior, 'center'),
      revealCard,
      revealColumn: (key) => scrollToColumn(key, 'smooth', 'center'),
    }
    return () => {
      apiRef.current = null
    }
  }, [apiRef, scrollToToday, revealCard, scrollToColumn])

  // IntersectionObserver：今天同名日期组列不在视口内时显示 FAB，并给出方向提示；
  // 无该列（组被改名/删除）时不挂 observer、不出 FAB（hasTodayCol 渲染期派生，effect 不置 state）
  const hasTodayCol = useMemo(() => groups.some((g) => g.name === TODAY), [groups, TODAY])
  useEffect(() => {
    const scroller = scrollerRef.current
    if (!scroller || !hasTodayCol) return
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
  }, [TODAY, groups, hasTodayCol])

  // ------------------------------------------------------------------
  // 键盘导航：T 回今天；←/→ ±7 天；Shift+←/→ ±30 天；输入框聚焦不触发。
  // 步进基准 = 视口中线列的 data-date（组名可解析为日期才工作，否则无操作）。
  // ------------------------------------------------------------------
  useEffect(() => {
    const midlineDate = (): string | null => {
      const scroller = scrollerRef.current
      const row = rowRef.current
      if (!scroller || !row || row.children.length === 0) return null
      const idx = Math.round(
        (scroller.scrollLeft + scroller.clientWidth / 2 - SIDE_PADDING - HALF_COL) / COLUMN_STEP,
      )
      const el = row.children[Math.max(0, Math.min(row.children.length - 1, idx))]
      return el?.getAttribute('data-date') // 未分组列/自定义名列无 data-date → null
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
        const base = midlineDate()
        if (!base) return // 中线列非日期组：±7 天无操作
        e.preventDefault()
        const step = e.shiftKey ? 30 : 7
        scrollToDate(addDays(base, e.key === 'ArrowRight' ? step : -step), 'smooth')
      } else if (e.key === 't' || e.key === 'T') {
        scrollToDate(TODAY, 'smooth')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [scrollToDate, TODAY])

  // ------------------------------------------------------------------
  // 拖拽（autoScroll 保持 dnd-kit 默认开启，拖到左右边缘自动横滚）。
  // 单一 DndContext 两类拖拽：
  //  - 卡片：跨列 = 改 group_id（'' = 移除字段归未分组）；同列 = orders 排序
  //  - 组列：列头 grip 拖动整列排序（horizontalListSortingStrategy）
  // ------------------------------------------------------------------
  /**
   * 碰撞判定（v19 修复「相邻日拖拽成功率低」，统一分组模型沿用）：
   * 1) pointerWithin 先锁定指针所在的「列」（横向看板直觉：指针在哪列就落哪列）；
   * 2) 列内仍用 closestCorners 选具体 over（卡片/列本身）——同列排序与
   *    卡片间中点插入语义与旧版一致；
   * 3) 指针在「非源列」时把拖拽卡自身移出候选，保住目标列 isOver 落点反馈；
   * 4) 指针不在任何列内 → 回落全局 closestCorners；
   * 5) 组列排序拖拽：候选限定为其它组列（pointerWithin → closestCorners）。
   * __dndOver 仅在 dev（含 e2e）下暴露最近一次判定胜出者，供验证脚本断言。
   */
  const boardCollisionDetection: CollisionDetection = (args) => {
    if (args.active.data.current?.type === 'group-column') {
      const scoped = {
        ...args,
        droppableContainers: args.droppableContainers.filter(
          (c) => c.data.current?.type === 'group-column',
        ),
      }
      const within = pointerWithin(scoped)
      return within.length > 0 ? within : closestCorners(scoped)
    }
    const within = pointerWithin(args)
    let collisions = within
    if (within.length > 0) {
      const columnHit =
        within.find((c) => c.data?.droppableContainer?.data?.current?.type === 'column') ??
        within[0]
      const key = columnHit.data?.droppableContainer?.data?.current?.date as string | undefined
      if (key !== undefined) {
        const scoped = closestCorners({
          ...args,
          droppableContainers: args.droppableContainers.filter(
            (c) =>
              c.data.current?.date === key &&
              (key === dragSourceKeyRef.current || c.id !== args.active.id),
          ),
        })
        if (scoped.length > 0) collisions = scoped
      }
    }
    if (collisions.length === 0) collisions = closestCorners(args)
    if (import.meta.env.DEV) {
      ;(window as unknown as { __dndOver?: string | null }).__dndOver = collisions[0]
        ? String(collisions[0].id)
        : null
    }
    return collisions
  }
  // 拖拽落定/取消后：click 事件紧跟 pointerup 同步触发，之后解除抑制
  const suppressTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const scheduleSuppressReset = () => {
    if (suppressTimer.current) clearTimeout(suppressTimer.current)
    suppressTimer.current = setTimeout(() => {
      suppressClickRef.current = false
    }, 150)
  }

  const handleDragStart = (e: DragStartEvent) => {
    suppressClickRef.current = true // 拖拽期间发生的 click 一律抑制
    const id = String(e.active.id)
    if (e.active.data.current?.type === 'group-column') {
      setActiveGroupId(String(e.active.data.current.groupId))
      return
    }
    snapshotRef.current = { items, orders }
    activeIdRef.current = id
    const dragging = items.find((c) => c.id === id)
    dragSourceKeyRef.current = dragging ? columnKeyOf(dragging) : null
    setActiveId(id)
  }

  /** 跨列数据层落写（乐观插入）：改 group_id（'' = 移除字段归未分组）；publish_at 不变 */
  const moveToColumn = (id: string | number, key: string) => {
    setItems((prev) =>
      prev.map((c) => {
        if (c.id !== id) return c
        const next = { ...c }
        if (key === '') delete next.group_id
        else next.group_id = key
        return next
      }),
    )
  }

  // 跨列乐观插入：给拖拽卡片一个位于邻居之间的 order，间隙不足时先归一化
  const handleDragOver = (e: DragOverEvent) => {
    const { active, over } = e
    if (!over) return
    if (active.data.current?.type === 'group-column') return // 列排序由 sortable 动画表达
    // data.date 承载列 key（分组 id / '' 未分组）
    const overKey = over.data.current?.date as string | undefined
    if (overKey === undefined) return

    const dragging = items.find((c) => c.id === active.id)
    if (!dragging) return
    if (columnKeyOf(dragging) === overKey) return // 同列由 sortable 动画表达

    const col = cardsInColumn(items, orders, overKey)
    let index = col.length
    if (over.data.current?.type === 'card') {
      const i = col.findIndex((c) => c.id === over.id)
      if (i >= 0) index = i
    }

    // 数据层：落写列归属（group_id）
    moveToColumn(active.id, overKey)

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

  // 落定：组列排序 → onMoveGroup；卡片 → 计算插入索引，对受影响列做 orders 归一化
  const handleDragEnd = (e: DragEndEvent) => {
    const { active, over } = e
    const isColumnDrag = active.data.current?.type === 'group-column'
    activeIdRef.current = null
    setActiveId(null)
    setActiveGroupId(null)
    snapshotRef.current = null
    scheduleSuppressReset()
    if (!over || over.id === active.id) return

    if (isColumnDrag) {
      const fromId = String(active.data.current?.groupId ?? '')
      const overId = String(over.data.current?.groupId ?? over.id)
      // arrayMove 等价语义：后移 = 插到 over 之后；前移 = 插到 over 之前
      const ids = groups.map((g) => g.id)
      const from = ids.indexOf(fromId)
      const to = ids.indexOf(overId)
      if (from >= 0 && to >= 0 && from !== to) {
        onMoveGroup?.(fromId, from < to ? (ids[to + 1] ?? null) : overId)
      }
      return
    }

    const overKey = over.data.current?.date as string | undefined
    if (overKey === undefined) return

    const dragging = items.find((c) => c.id === active.id)
    if (!dragging) return

    // 跨列拖拽但 dragOver 未覆盖到的兜底：落定前确保列归属已切换
    if (columnKeyOf(dragging) !== overKey) {
      moveToColumn(active.id, overKey)
    }

    const col = cardsInColumn(items, orders, overKey).filter((c) => c.id !== active.id)
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
    setActiveGroupId(null)
    scheduleSuppressReset()
  }

  const groupFull = groups.length >= MAX_GROUPS

  return (
    <div className="relative min-h-0 flex-1">
      <DndContext
        sensors={sensors}
        collisionDetection={boardCollisionDetection}
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
          onClickCapture={(e) => {
            if (suppressClickRef.current) {
              suppressClickRef.current = false
              e.stopPropagation()
              e.preventDefault()
            }
          }}
        >
          <SortableContext
            items={groups.map((g) => `gcol:${g.id}`)}
            strategy={horizontalListSortingStrategy}
          >
            <div ref={rowRef} className="flex w-max items-stretch gap-3 px-4 pb-20">
              {/* 未分组虚拟列恒第一 + groups 数组序；空组照常显示 */}
              {columns.map((col) => (
                <GroupColumn
                  key={col.key || 'ungrouped'}
                  colKey={col.key}
                  name={col.name}
                  cards={grouped.get(col.key) ?? EMPTY_CARDS}
                  onOpenDetail={onOpenDetail}
                  onDelete={onDelete}
                  onAddCard={onAddCard}
                  onSetBgColor={onSetBgColor}
                  onToggleDimmed={onToggleDimmed}
                  onCopyShareLink={onCopyShareLink}
                  highlightId={highlightId}
                  canAdd={canAdd}
                  onRenameGroup={col.key ? onRenameGroup : undefined}
                  onDeleteGroup={col.key ? onDeleteGroup : undefined}
                />
              ))}
              {/* 末尾「+ 新建分组」虚线柱（满 61 禁用） */}
              <button
                type="button"
                data-add-group
                disabled={groupFull}
                title={groupFull ? `分组已达上限 ${MAX_GROUPS} 个` : '新建分组'}
                onClick={() => onAddGroup?.()}
                className={
                  groupFull
                    ? 'flex w-[120px] shrink-0 cursor-not-allowed items-center justify-center self-stretch rounded-2xl border border-dashed border-slate-200 text-xs text-slate-300'
                    : 'flex w-[120px] shrink-0 items-center justify-center self-stretch rounded-2xl border border-dashed border-slate-300 text-xs text-slate-400 transition-colors duration-150 hover:border-indigo-300 hover:bg-white/70 hover:text-indigo-500'
                }
              >
                + 新建分组
              </button>
            </div>
          </SortableContext>
        </div>

        <DragOverlay dropAnimation={{ duration: 180 }}>
          {activeCard ? (
            <OverlayCard card={activeCard} />
          ) : activeGroup ? (
            <div className="w-[236px] rounded-2xl border border-indigo-300 bg-white/95 px-4 py-3 text-sm font-semibold text-slate-700 shadow-[0_16px_40px_-12px_rgba(15,23,42,0.35)]">
              {activeGroup.name}
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>

      {/* v17 minimap：全跨度密度热力 + 月刻度 + 今天线 + 窗口框（可拖/可点）。
          v2-M2：代码零改动，center 恒传 TODAY —— dim 遮罩 = 今天 ±30 天外，
          与迁移窗口（61 个日期组）天然对齐 */}
      <BoardMinimap
        items={items}
        center={TODAY}
        scrollerRef={scrollerRef}
        onScrub={(date) => scrollToDate(date, 'auto')}
      />

      {/* 回到今天 FAB：今天列不在视口内时才显示，箭头指向今天列方向 */}
      {fab && hasTodayCol && (
        <button
          type="button"
          onClick={() => scrollToToday('smooth', 'center')}
          className="absolute bottom-16 right-5 z-30 flex items-center gap-1.5 rounded-full border border-slate-200 bg-white/95 px-4 py-2 text-sm font-medium text-slate-700 shadow-[0_10px_28px_-10px_rgba(15,23,42,0.35)] backdrop-blur transition-all duration-150 hover:-translate-y-px hover:border-indigo-300 hover:text-indigo-600"
        >
          <span className="text-indigo-500">{fab.dir === 'left' ? '←' : '→'}</span>
          回到今天
        </button>
      )}
    </div>
  )
}
