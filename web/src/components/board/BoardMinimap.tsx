import { useCallback, useEffect, useMemo, useRef } from 'react'
import type { ContentItem } from '@timeline/core/types'
import { WINDOW_DAYS, WINDOW_RADIUS, addDays, dayDiff, pad2, todayStr } from '@/lib/content-data'
import { publishDateOf } from '@timeline/core/board-view'

const COLUMN_STEP = 236 + 12
const SIDE_PADDING = 16
/** 视口框最小视觉宽（px）；隐形热区左右各扩 6px */
const MIN_FRAME_PX = 10
const HOT_PAD_PX = 6

interface BoardMinimapProps {
  items: ContentItem[]
  /** 当前窗口中心日期（窗口滑动时触发重渲染；滚动跟随走 DOM 直写不经过这里） */
  center: string
  scrollerRef: React.RefObject<HTMLDivElement | null>
  /** 拖拽视口框 / 点击轨道时实时回调目标日期（Board.jumpTo） */
  onScrub: (date: string) => void
}

const WEEK = '日一二三四五六'
/** tooltip 日期格式：「9月15日 周二」 */
function fmtTip(date: string): string {
  const [y, m, d] = date.split('-').map(Number)
  return `${m}月${d}日 周${WEEK[new Date(y, m - 1, d).getDay()]}`
}

/**
 * v17 看板 minimap（Dense-data 风格纯表现层重设计）：
 * - 跨度 = 第一张卡片日期 → 最后一张卡片日期（无 ±7 余量、无「至少含今天」钳制）；
 * - 密度 = 量化圆点：每天一列位置，竖向堆叠 0–3 点（1–2 张=1 点、3–5 张=2 点、≥6 张=3 点）；
 * - 视口框 = 屏幕实际可见列范围（≈5.5 天，真实比例，最小 10px + 左右各 6px 隐形热区），
 *   indigo 边框 + 浅填充 + 框顶中心小刻度；拖框 = scrub 看板中心，点轨道 = 跳转；
 * - 压暗 = 61 天已加载窗口之外的左右两片 slate 半透明遮罩（DOM 直写随窗口滑动）；
 *   跨度 <61 天（全量已加载）时遮罩自然为 0 宽隐藏；
 * - 今天 = 轨道上一个 rose 红点（垂直居中），不再画贯穿线；中心日由框中心刻度承担；
 * - 日期 tooltip：悬停轨道跟随光标读「所指日期」，拖框时读「框中心日期」，全部 DOM 直写；
 * - 拖拽框先行：pointermove → rAF 合流，每帧先 transform: translateX 直写框与 tooltip
 *   （GPU 合成路径，不写 left%），再回调一次 onScrub（每帧最多一次，避免窗口重建风暴）；
 *   滚动跟随路径同样 transform 直写。保留 pointer capture / touch-action: none / passive。
 */
export default function BoardMinimap({ items, center, scrollerRef, onScrub }: BoardMinimapProps) {
  const trackRef = useRef<HTMLDivElement>(null)
  const frameRef = useRef<HTMLDivElement>(null)
  const dimLRef = useRef<HTMLDivElement>(null)
  const dimRRef = useRef<HTMLDivElement>(null)
  const tipRef = useRef<HTMLDivElement>(null)
  const TODAY = todayStr()

  // 跨度：第一张卡 → 最后一张卡（空板/单卡退化为 today→today 一天）
  const { start, end, spanDays } = useMemo(() => {
    let min: string | null = null
    let max: string | null = null
    for (const it of items) {
      const d = publishDateOf(it)
      if (min === null || d < min) min = d
      if (max === null || d > max) max = d
    }
    const s = min ?? TODAY
    const e = max ?? TODAY
    return { start: s, end: e, spanDays: dayDiff(e, s) + 1 }
  }, [items, TODAY])

  // 直写回调用的最新几何基准（react-hooks/refs：render 期不写 ref，统一在 effect 同步）
  const geomRef = useRef({ base: 0, start, spanDays })
  // base = 61 天加载窗口首日相对跨度起点的天数（可为负：窗口左缘在跨度之外）

  // 按天计数 → 量化点阵（0–3 点）
  const dayCols = useMemo(() => {
    const counts = new Map<string, number>()
    for (const it of items) {
      const d = publishDateOf(it)
      counts.set(d, (counts.get(d) ?? 0) + 1)
    }
    const out: { date: string; idx: number; level: number }[] = []
    for (const [date, count] of counts) {
      const idx = dayDiff(date, start)
      if (idx < 0 || idx >= spanDays) continue
      out.push({ date, idx, level: count >= 6 ? 3 : count >= 3 ? 2 : 1 })
    }
    return out
  }, [items, start, spanDays])

  // 月刻度（1 月附带年份）：全高细线 + 顶部标签
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

  const todayInSpan = TODAY >= start && TODAY <= end
  const todayPct = (dayDiff(TODAY, start) + 0.5) / spanDays * 100

  // ------------------------------------------------------------------
  // DOM 直写：视口框（transform）、压暗遮罩（width/transform）、tooltip
  // ------------------------------------------------------------------
  const trackGeom = useCallback(() => {
    const track = trackRef.current
    if (!track) return null
    const r = track.getBoundingClientRect()
    return r.width > 0 ? { left: r.left, w: r.width } : null
  }, [])

  /** 视口框 + 压暗随真实视口/窗口重同步（scroll / resize / 窗口滑动 / 拖拽结束） */
  const updateFrame = useCallback(() => {
    const scroller = scrollerRef.current
    const frame = frameRef.current
    const tg = trackGeom()
    if (!scroller || !frame || !tg) return
    const { base, spanDays } = geomRef.current
    // 视口覆盖的（小数）天区间：[v0, v0+vdays]，相对跨度起点
    const v0 = base + (scroller.scrollLeft - SIDE_PADDING) / COLUMN_STEP
    const vdays = scroller.clientWidth / COLUMN_STEP
    const visualW = Math.max(MIN_FRAME_PX, Math.min(tg.w, (vdays / spanDays) * tg.w))
    const x = Math.max(0, Math.min(tg.w - visualW, (v0 / spanDays) * tg.w))
    frame.style.transform = `translateX(${x}px)`
    frame.style.width = `${visualW}px`
    // 压暗：加载窗口 = [center-30, center+30] → 相对跨度的 [base, base+61]
    const lw = Math.max(0, Math.min(tg.w, (base / spanDays) * tg.w))
    const rx = Math.max(0, Math.min(tg.w, ((base + WINDOW_DAYS) / spanDays) * tg.w))
    const dimL = dimLRef.current
    const dimR = dimRRef.current
    if (dimL) {
      dimL.style.width = `${lw}px`
      dimL.style.visibility = lw < 0.5 ? 'hidden' : 'visible'
    }
    if (dimR) {
      dimR.style.transform = `translateX(${rx}px)`
      dimR.style.width = `${tg.w - rx}px`
      dimR.style.visibility = tg.w - rx < 0.5 ? 'hidden' : 'visible'
    }
  }, [scrollerRef, trackGeom])

  /** tooltip：cx 为轨道内 x（px），date 已格式化；hidden 时收起 */
  const writeTip = useCallback((cx: number | null, date: string | null) => {
    const tip = tipRef.current
    const tg = trackGeom()
    if (!tip || !tg) return
    if (cx === null || date === null) {
      tip.style.opacity = '0'
      return
    }
    tip.textContent = fmtTip(date)
    const tw = tip.offsetWidth
    const x = Math.max(0, Math.min(tg.w - tw, cx - tw / 2))
    tip.style.transform = `translateX(${x}px)`
    tip.style.opacity = '1'
  }, [trackGeom])

  const fracToDate = useCallback((frac: number): string => {
    const { start: s, spanDays: sd } = geomRef.current
    const idx = Math.max(0, Math.min(sd - 1, Math.floor(frac * sd)))
    return addDays(s, idx)
  }, [])

  // 几何基准同步 + 重同步（窗口滑动 / 数据变化 / 挂载）
  useEffect(() => {
    geomRef.current = { base: dayDiff(addDays(center, -WINDOW_RADIUS), start), start, spanDays }
    updateFrame()
  }, [center, start, spanDays, updateFrame])

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
  // 交互：点轨道跳到该日期；拖视口框实时跟随（pointer capture + 框先行 rAF 合流）
  // ------------------------------------------------------------------
  const dragRef = useRef<{ id: number; dx: number; latestX: number; raf: number } | null>(null)

  const onTrackPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const tg = trackGeom()
    if (!tg) return
    onScrub(fracToDate((e.clientX - tg.left) / tg.w))
  }

  const onTrackPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (dragRef.current) return // 拖框期间 tooltip 由拖拽路径驱动
    const tg = trackGeom()
    if (!tg) return
    const x = e.clientX - tg.left
    writeTip(x, fracToDate(x / tg.w))
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
    const centerDate = fracToDate((x + frameW / 2) / tg.w)
    writeTip(x + frameW / 2, centerDate)
    onScrubRef.current(centerDate)
  }, [fracToDate, writeTip, trackGeom])

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

        {/* 月刻度（全高细线 + 顶部标签） */}
        {monthTicks.map((t) => (
          <div
            key={t.date}
            className="pointer-events-none absolute bottom-0 top-0"
            style={{ left: `${t.left}%` }}
          >
            <div className="absolute bottom-0 top-0 w-px bg-slate-200/70" />
            <span
              data-minimap-month
              className="absolute left-0.5 top-0 whitespace-nowrap text-[9px] leading-3 text-slate-400"
            >
              {t.label}
            </span>
          </div>
        ))}

        {/* 密度量化圆点：每天一列位置，竖向堆叠 0–3 点 */}
        {dayCols.map((c) => (
          <div
            key={c.date}
            data-minimap-daycol
            data-date={c.date}
            className="absolute bottom-0"
            style={{ left: `${((c.idx + 0.5) / spanDays) * 100}%` }}
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

        {/* 今天：rose 红点（垂直居中），跨度外不渲染 */}
        {todayInSpan && (
          <div
            data-minimap-today
            className="absolute top-1/2 h-1 w-1 -translate-x-1/2 -translate-y-1/2 rounded-full bg-rose-500"
            style={{ left: `${todayPct}%` }}
          />
        )}

        {/* 压暗：加载窗口之外的左右两片遮罩（DOM 直写；pointer-events 穿透） */}
        <div
          ref={dimLRef}
          data-minimap-dim-left
          className="pointer-events-none absolute bottom-0 left-0 top-0 border-r border-slate-400/30 bg-slate-400/25"
          style={{ width: 0, visibility: 'hidden' }}
        />
        <div
          ref={dimRRef}
          data-minimap-dim-right
          className="pointer-events-none absolute bottom-0 left-0 top-0 border-l border-slate-400/30 bg-slate-400/25"
          style={{ width: 0, transform: 'translateX(0px)', visibility: 'hidden' }}
        />

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

      {/* 日期 tooltip（DOM 直写：悬停读所指日期，拖框读框中心日期） */}
      <div
        ref={tipRef}
        data-minimap-tooltip
        className="pointer-events-none absolute bottom-10 left-0 z-30 whitespace-nowrap rounded-md bg-slate-800/90 px-2 py-1 text-[11px] tabular-nums text-white opacity-0 shadow-lg transition-opacity duration-100"
        style={{ transform: 'translateX(0px)' }}
      />
    </div>
  )
}
