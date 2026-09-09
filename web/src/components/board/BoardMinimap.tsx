import { useCallback, useEffect, useMemo, useRef } from 'react'
import type { ContentItem, Group } from '@timeline/core/types'
import { columnKeyOf } from '@timeline/core/board-view'
import { todayStr } from '@/lib/content-data'

const COLUMN_STEP = 236 + 12
const SIDE_PADDING = 16
/** 视口框最小视觉宽（px）；隐形热区左右各扩 6px */
const MIN_FRAME_PX = 10
const HOT_PAD_PX = 6

interface BoardMinimapProps {
  items: ContentItem[]
  /** 分组（数组序 = 列序）；轨道 = 未分组虚拟列 + groups[]，共 N 列等分 */
  groups: Group[]
  scrollerRef: React.RefObject<HTMLDivElement | null>
  /** 拖拽视口框 / 点击轨道时实时回调目标列 key（'' = 未分组列；Board.scrollToColumn） */
  onScrub: (groupKey: string) => void
}

interface ColMark {
  key: string
  name: string
  idx: number
  /** 密度量化 0–3 点：1–2 张=1 点、3–5 张=2 点、≥6 张=3 点、0 张=0 点 */
  level: number
}

/**
 * v2-M2 组数驱动 minimap（去日期化重写；交互机制沿用 v17 版）：
 * - 轨道 = 列序列：未分组列 + groups[]（数组序），N 列等分轨道宽度——离群卡的
 *   publish_at 不再拉伸轨道（日期与分组已脱钩）；
 * - 密度点 = 每组卡数量化 0–3 点（规则不变），按列位置渲染，不再按日期散落；
 * - 视口框 = scrollLeft→列索引映射（COLUMN_STEP 等宽列成立），indigo 边框 + 浅填充 +
 *   框顶中心小刻度；拖框 = scrub 看板列，点轨道 = 跳转；
 * - 月刻度 / dim 左右遮罩退役（窗口概念已死）；今天红点仅当存在组名 == 今天日期
 *   （YYYY-MM-DD）的组时落在该组位置，否则不渲染；
 * - tooltip 读组名（未分组列读「未分组」）：悬停读所指列，拖框读框中心列，全部 DOM 直写；
 * - 拖拽框先行：pointermove → rAF 合流，每帧先 transform: translateX 直写框与 tooltip
 *   （GPU 合成路径），再回调一次 onScrub（每帧最多一次）；滚动跟随同样 transform 直写。
 *   保留 pointer capture / touch-action: none / passive。
 */
export default function BoardMinimap({ items, groups, scrollerRef, onScrub }: BoardMinimapProps) {
  const trackRef = useRef<HTMLDivElement>(null)
  const frameRef = useRef<HTMLDivElement>(null)
  const tipRef = useRef<HTMLDivElement>(null)
  const TODAY = todayStr()

  // 列定义：虚拟「未分组」列恒第一 + groups 数组序（与 Board.columns 同源）
  const columns = useMemo(
    () => [{ key: '', name: '未分组' }, ...groups.map((g) => ({ key: g.id, name: g.name }))],
    [groups],
  )
  const colCount = columns.length

  // 每组卡数 → 量化点阵（0–3 点）
  const colMarks = useMemo<ColMark[]>(() => {
    const counts = new Map<string, number>()
    for (const it of items) {
      const k = columnKeyOf(it)
      counts.set(k, (counts.get(k) ?? 0) + 1)
    }
    return columns.map((c, idx) => {
      const n = counts.get(c.key) ?? 0
      return { key: c.key, name: c.name, idx, level: n >= 6 ? 3 : n >= 3 ? 2 : n >= 1 ? 1 : 0 }
    })
  }, [items, columns])

  // 今天红点：仅当存在组名 == 今天日期的组时落位（未分组列名不是日期，天然排除）
  const todayIdx = useMemo(() => groups.findIndex((g) => g.name === TODAY), [groups, TODAY])

  // 直写回调用的最新列数据（react-hooks/refs：render 期不写 ref，统一在 effect 同步）
  const columnsRef = useRef(columns)
  const geomRef = useRef({ n: colCount })

  // ------------------------------------------------------------------
  // DOM 直写：视口框（transform）、tooltip
  // ------------------------------------------------------------------
  const trackGeom = useCallback(() => {
    const track = trackRef.current
    if (!track) return null
    const r = track.getBoundingClientRect()
    return r.width > 0 ? { left: r.left, w: r.width } : null
  }, [])

  /** 视口框随真实视口重同步（scroll / resize / 列数变化 / 拖拽结束） */
  const updateFrame = useCallback(() => {
    const scroller = scrollerRef.current
    const frame = frameRef.current
    const tg = trackGeom()
    if (!scroller || !frame || !tg) return
    const { n } = geomRef.current
    if (n <= 0) return
    // 视口覆盖的（小数）列区间：[v0, v0+vcols]，等宽列直接映射
    const v0 = (scroller.scrollLeft - SIDE_PADDING) / COLUMN_STEP
    const vcols = scroller.clientWidth / COLUMN_STEP
    const visualW = Math.max(MIN_FRAME_PX, Math.min(tg.w, (vcols / n) * tg.w))
    const x = Math.max(0, Math.min(tg.w - visualW, (v0 / n) * tg.w))
    frame.style.transform = `translateX(${x}px)`
    frame.style.width = `${visualW}px`
  }, [scrollerRef, trackGeom])

  /** tooltip：cx 为轨道内 x（px），text 为组名；null 时收起 */
  const writeTip = useCallback(
    (cx: number | null, text: string | null) => {
      const tip = tipRef.current
      const tg = trackGeom()
      if (!tip || !tg) return
      if (cx === null || text === null) {
        tip.style.opacity = '0'
        return
      }
      tip.textContent = text
      const tw = tip.offsetWidth
      const x = Math.max(0, Math.min(tg.w - tw, cx - tw / 2))
      tip.style.transform = `translateX(${x}px)`
      tip.style.opacity = '1'
    },
    [trackGeom],
  )

  /** 轨道比例 → 列（等分映射） */
  const fracToCol = useCallback((frac: number): { key: string; name: string } => {
    const cols = columnsRef.current
    const n = geomRef.current.n
    const idx = Math.max(0, Math.min(n - 1, Math.floor(frac * n)))
    return cols[idx] ?? { key: '', name: '未分组' }
  }, [])

  // 几何基准同步 + 重同步（列数/数据变化 / 挂载）
  useEffect(() => {
    columnsRef.current = columns
    geomRef.current = { n: colCount }
    updateFrame()
  }, [columns, colCount, updateFrame])

  // 滚动 / resize → 视口框跟随（passive；DOM 直写不触发 React 渲染）
  useEffect(() => {
    const scroller = scrollerRef.current
    if (!scroller) return
    const onScroll = () => updateFrame()
    scroller.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', onScroll)
    return () => {
      scroller.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', onScroll)
    }
  }, [scrollerRef, updateFrame])

  // ------------------------------------------------------------------
  // 交互：点轨道跳到该列；拖视口框实时跟随（pointer capture + 框先行 rAF 合流）
  // ------------------------------------------------------------------
  const dragRef = useRef<{ id: number; dx: number; latestX: number; raf: number } | null>(null)

  const onTrackPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const tg = trackGeom()
    if (!tg) return
    onScrub(fracToCol((e.clientX - tg.left) / tg.w).key)
  }

  const onTrackPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (dragRef.current) return // 拖框期间 tooltip 由拖拽路径驱动
    const tg = trackGeom()
    if (!tg) return
    const x = e.clientX - tg.left
    const col = fracToCol(x / tg.w)
    writeTip(x, col.name)
  }

  const onTrackPointerLeave = () => {
    if (!dragRef.current) writeTip(null, null)
  }

  // onScrub 经 ref 调用：applyDrag 不因其身份变化而重建
  const onScrubRef = useRef(onScrub)
  useEffect(() => {
    onScrubRef.current = onScrub
  }, [onScrub])

  /** 框先行：先 transform 直写框与 tooltip，再回调 onScrub（每帧最多一次） */
  const applyDrag = useCallback(() => {
    const drag = dragRef.current
    const frame = frameRef.current
    const tg = trackGeom()
    if (!drag || !frame || !tg) return
    const frameW = frame.getBoundingClientRect().width
    const x = Math.max(0, Math.min(tg.w - frameW, drag.latestX - tg.left - drag.dx))
    frame.style.transform = `translateX(${x}px)`
    const centerCol = fracToCol((x + frameW / 2) / tg.w)
    writeTip(x + frameW / 2, centerCol.name)
    onScrubRef.current(centerCol.key)
  }, [fracToCol, writeTip, trackGeom])

  const onFramePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.stopPropagation()
    e.preventDefault()
    const frame = frameRef.current
    if (!frame) return
    frame.setPointerCapture(e.pointerId)
    dragRef.current = {
      id: e.pointerId,
      dx: e.clientX - frame.getBoundingClientRect().left,
      latestX: e.clientX,
      raf: 0,
    }
  }

  const onFramePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag || drag.id !== e.pointerId) return
    drag.latestX = e.clientX
    if (!drag.raf) {
      drag.raf = requestAnimationFrame(() => {
        drag.raf = 0
        applyDrag()
      })
    }
  }

  const onFramePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag || drag.id !== e.pointerId) return
    if (drag.raf) cancelAnimationFrame(drag.raf)
    dragRef.current = null
    writeTip(null, null)
    updateFrame() // 以真实视口重同步（拖拽路径的估算值就此交还）
  }

  return (
    <div className="absolute inset-x-0 bottom-0 z-20 flex h-12 items-center border-t border-slate-200/70 bg-white/80 px-4 backdrop-blur">
      <div
        ref={trackRef}
        data-minimap
        onPointerDown={onTrackPointerDown}
        onPointerMove={onTrackPointerMove}
        onPointerLeave={onTrackPointerLeave}
        className="relative h-7 flex-1 cursor-pointer select-none"
      >
        {/* 基线 */}
        <div className="absolute inset-x-0 bottom-0 h-px bg-slate-200" />

        {/* 密度量化圆点：每列一个位置（N 列等分），竖向堆叠 0–3 点 */}
        {colMarks.map((c) => (
          <div
            key={c.key || '__ungrouped__'}
            data-minimap-daycol
            data-group-key={c.key}
            className="absolute bottom-0"
            style={{ left: `${((c.idx + 0.5) / colCount) * 100}%` }}
          >
            {Array.from({ length: c.level }, (_, i) => (
              <div
                key={i}
                data-minimap-dot
                className="absolute h-[3px] w-[3px] -translate-x-1/2 rounded-full bg-indigo-400"
                style={{ bottom: 1 + i * 4 }}
              />
            ))}
          </div>
        ))}

        {/* 今天：rose 红点（垂直居中）；仅当存在组名 == 今天日期的组时渲染 */}
        {todayIdx >= 0 && (
          <div
            data-minimap-today
            className="absolute top-1/2 h-1 w-1 -translate-x-1/2 -translate-y-1/2 rounded-full bg-rose-500"
            style={{ left: `${((todayIdx + 1 + 0.5) / colCount) * 100}%` }}
          />
        )}

        {/* 视口框（位置/宽度由 updateFrame 直写 transform；可拖拽，框顶中心小刻度） */}
        <div
          ref={frameRef}
          data-minimap-window
          onPointerDown={onFramePointerDown}
          onPointerMove={onFramePointerMove}
          onPointerUp={onFramePointerUp}
          onPointerCancel={onFramePointerUp}
          className="absolute bottom-0 top-0 cursor-grab touch-none rounded-md border border-indigo-500/70 bg-indigo-500/10 shadow-[0_1px_4px_rgba(79,70,229,0.15)] active:cursor-grabbing"
          style={{ left: 0, width: MIN_FRAME_PX, transform: 'translateX(0px)' }}
        >
          <div
            data-minimap-viewport-tick
            className="absolute -top-px left-1/2 h-1.5 w-[2px] -translate-x-1/2 rounded-b-[1px] bg-indigo-500/80"
          />
          {/* 隐形热区：左右各扩 6px（视觉最窄 10px → 热区约 22px） */}
          <div className="absolute inset-y-0" style={{ left: -HOT_PAD_PX, right: -HOT_PAD_PX }} />
        </div>
      </div>

      {/* 组名 tooltip（DOM 直写：悬停读所指列，拖框读框中心列；未分组列读「未分组」） */}
      <div
        ref={tipRef}
        data-minimap-tooltip
        className="pointer-events-none absolute bottom-10 left-0 z-30 whitespace-nowrap rounded-md bg-slate-800/90 px-2 py-1 text-[11px] tabular-nums text-white opacity-0 shadow-lg transition-opacity duration-100"
        style={{ transform: 'translateX(0px)' }}
      />
    </div>
  )
}
