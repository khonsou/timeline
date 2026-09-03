import { useCallback, useEffect, useMemo, useRef } from 'react'
import type { ContentItem } from '@/types/content'
import {
  WINDOW_DAYS,
  WINDOW_RADIUS,
  addDays,
  dayDiff,
  pad2,
  todayStr,
} from '@/lib/content-data'
import { publishDateOf } from '@/lib/board-view'

const COLUMN_STEP = 236 + 12
const SIDE_PADDING = 16
const HALF_COL = 236 / 2
const EDGE_MARGIN = 7 // 跨度两端余量（天）
const MAX_BUCKETS = 240 // 密度桶上限（跨度大时按多天一桶聚合）

interface BoardMinimapProps {
  items: ContentItem[]
  /** 当前窗口中心日期（窗口滑动时触发重渲染；滚动跟随走 DOM 直写不经过这里） */
  center: string
  scrollerRef: React.RefObject<HTMLDivElement | null>
  /** 拖拽窗口框 / 点击轨道时实时回调目标日期（Board.jumpTo） */
  onScrub: (date: string) => void
}

/**
 * v16 看板 minimap：整板数据跨度的密度热力条 + 月刻度 + 今天线 + 当前 61 天窗口框。
 * - 窗口框中心 = 视口中线日期：监听 scroller scroll 直接写 style（不经 React 渲染）；
 * - 拖框（pointer capture）/ 点轨道 → onScrub 实时驱动看板跳转（双向同步）。
 */
export default function BoardMinimap({ items, center, scrollerRef, onScrub }: BoardMinimapProps) {
  const trackRef = useRef<HTMLDivElement>(null)
  const frameRef = useRef<HTMLDivElement>(null)
  const TODAY = todayStr()

  // 跨度：min(最早卡, 今天) - 7 天 → max(最晚卡, 今天) + 7 天
  const { start, end, spanDays } = useMemo(() => {
    let min = TODAY
    let max = TODAY
    for (const it of items) {
      const d = publishDateOf(it)
      if (d < min) min = d
      if (d > max) max = d
    }
    const s = addDays(min, -EDGE_MARGIN)
    const e = addDays(max, EDGE_MARGIN)
    return { start: s, end: e, spanDays: dayDiff(e, s) + 1 }
  }, [items, TODAY])

  // 滚动跟随用的最新基准（直写 style 的回调不能拿陈旧闭包）
  const baseRef = useRef(0) // 窗口首日相对跨度起点的天数
  const spanRef = useRef(spanDays)
  baseRef.current = dayDiff(addDays(center, -WINDOW_RADIUS), start)
  spanRef.current = spanDays

  // 按天密度 → 桶（高度 + 透明度 ∝ 密度）
  const buckets = useMemo(() => {
    const n = Math.min(spanDays, MAX_BUCKETS)
    const counts = new Array<number>(n).fill(0)
    const per = spanDays / n
    for (const it of items) {
      const d = dayDiff(publishDateOf(it), start)
      if (d < 0 || d >= spanDays) continue
      counts[Math.min(n - 1, Math.floor(d / per))] += 1
    }
    const maxCount = Math.max(1, ...counts)
    return counts.map((count, i) => ({
      left: (i / n) * 100,
      width: 100 / n,
      count,
      heightPct: count === 0 ? 0 : Math.max(18, (count / maxCount) * 100),
      opacity: count === 0 ? 0 : 0.3 + 0.7 * (count / maxCount),
    }))
  }, [items, start, spanDays])

  // 月刻度（1 月附带年份）
  const monthTicks = useMemo(() => {
    const [sy, sm, sd] = start.split('-').map(Number)
    let y = sy
    let m = sd === 1 ? sm : sm + 1
    if (m > 12) {
      m = 1
      y += 1
    }
    const ticks: { date: string; label: string; left: number }[] = []
    for (;;) {
      const d = `${y}-${pad2(m)}-01`
      if (d > end) break
      if (d >= start) {
        ticks.push({
          date: d,
          label: m === 1 ? `${y} 年` : `${m} 月`,
          left: (dayDiff(d, start) / spanDays) * 100,
        })
      }
      m += 1
      if (m > 12) {
        m = 1
        y += 1
      }
    }
    return ticks
  }, [start, end, spanDays])

  const todayPct = (dayDiff(TODAY, start) / spanDays) * 100

  // 窗口框位置：框中心 = 视口中线日期（列索引小数 → 相对跨度的天数 → 百分比）
  const updateFrame = useCallback(() => {
    const scroller = scrollerRef.current
    const frame = frameRef.current
    if (!scroller || !frame) return
    const fracIdx =
      (scroller.scrollLeft + scroller.clientWidth / 2 - SIDE_PADDING - HALF_COL) / COLUMN_STEP
    const span = spanRef.current
    const frameDays = Math.min(WINDOW_DAYS, span)
    const halfWPct = (frameDays / span / 2) * 100
    let centerPct = ((baseRef.current + fracIdx) / span) * 100
    centerPct = Math.max(halfWPct, Math.min(100 - halfWPct, centerPct))
    frame.style.left = `${centerPct - halfWPct}%`
    frame.style.width = `${halfWPct * 2}%`
  }, [scrollerRef])

  // 滚动 /  resize / 窗口滑动 / 数据变化 → 同步窗口框（scroll 走 DOM 直写不触发渲染）
  useEffect(() => {
    const scroller = scrollerRef.current
    if (!scroller) return
    const onScroll = () => updateFrame()
    scroller.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', onScroll)
    updateFrame()
    return () => {
      scroller.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', onScroll)
    }
  }, [scrollerRef, updateFrame, center, start, spanDays])

  // ------------------------------------------------------------------
  // 交互：点轨道跳到该日期；拖窗口框实时跟随（pointer capture）
  // ------------------------------------------------------------------
  const dragRef = useRef<{ dx: number; id: number } | null>(null)

  const dateAtFrac = (frac: number): string => {
    const clamped = Math.max(0, Math.min(0.999999, frac))
    return addDays(start, Math.round(clamped * (spanDays - 1)))
  }

  const onTrackPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const track = trackRef.current
    if (!track) return
    const r = track.getBoundingClientRect()
    onScrub(dateAtFrac((e.clientX - r.left) / r.width))
  }

  const onFramePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.stopPropagation()
    e.preventDefault()
    const frame = frameRef.current
    if (!frame) return
    frame.setPointerCapture(e.pointerId)
    dragRef.current = { dx: e.clientX - frame.getBoundingClientRect().left, id: e.pointerId }
  }

  const onFramePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    const track = trackRef.current
    const frame = frameRef.current
    if (!drag || drag.id !== e.pointerId || !track || !frame) return
    const tr = track.getBoundingClientRect()
    const fr = frame.getBoundingClientRect()
    const centerX = e.clientX - drag.dx + fr.width / 2 - tr.left
    onScrub(dateAtFrac(centerX / tr.width))
  }

  const onFramePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.id === e.pointerId) dragRef.current = null
  }

  return (
    <div className="absolute inset-x-0 bottom-0 z-20 flex h-12 items-center border-t border-slate-200/70 bg-white/80 px-4 backdrop-blur">
      <div
        ref={trackRef}
        data-minimap
        onPointerDown={onTrackPointerDown}
        className="relative h-7 flex-1 cursor-pointer select-none"
      >
        {/* 基线 */}
        <div className="absolute inset-x-0 bottom-0 h-px bg-slate-200" />

        {/* 密度热力条 */}
        {buckets.map((b, i) =>
          b.count > 0 ? (
            <div
              key={i}
              data-minimap-bar
              className="absolute bottom-0 rounded-t-[1px] bg-indigo-400"
              style={{
                left: `${b.left}%`,
                width: `${b.width}%`,
                height: `${b.heightPct}%`,
                opacity: b.opacity,
              }}
            />
          ) : null,
        )}

        {/* 月刻度 */}
        {monthTicks.map((t) => (
          <div key={t.date} className="absolute bottom-0 top-0" style={{ left: `${t.left}%` }}>
            <div className="absolute bottom-0 h-1.5 w-px bg-slate-300" />
            <span className="absolute left-0.5 top-0 whitespace-nowrap text-[9px] leading-3 text-slate-400">
              {t.label}
            </span>
          </div>
        ))}

        {/* 今天线 */}
        <div
          data-minimap-today
          className="absolute bottom-0 top-0 w-px bg-rose-400"
          style={{ left: `${todayPct}%` }}
        />

        {/* 当前 61 天窗口框（位置由 scroll 监听直写 style；可拖拽） */}
        <div
          ref={frameRef}
          data-minimap-window
          onPointerDown={onFramePointerDown}
          onPointerMove={onFramePointerMove}
          onPointerUp={onFramePointerUp}
          onPointerCancel={onFramePointerUp}
          className="absolute bottom-0 top-0 cursor-grab touch-none rounded-md border border-indigo-500/70 bg-indigo-500/10 shadow-[0_1px_4px_rgba(79,70,229,0.15)] active:cursor-grabbing"
          style={{ left: '0%', width: '100%' }}
        />
      </div>
    </div>
  )
}
