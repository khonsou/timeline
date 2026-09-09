/**
 * v2-M3 F4 关系视图（BoardGraph）：卡片多对多依赖图，看板内容区 div 级替换（非新页面）。
 *
 * - 布局：core layoutGraph（longest-path 分层：节点层 = 最长前序链长度；层内按 orders
 *   横排，只读反映——图视图内不做层内拖拽排序、不引入 dnd-kit；遇环降级断边标黄）
 * - 节点：复用 BoardCard 的 CardView 完整卡片面（类型胶囊/状态/指标/时间胶囊/产品名/
 *   bg_color 底色/dimmed 半透明——视觉与时间线完全一致；toolbar 关闭，仅有点击开详情 +
 *   边缘手柄拖拽连线）；仅「有关系的卡」进图（无 pre/post 的孤立卡不渲染——空板即空图）
 * - 边：普通细线（slate）；「前序已发布 → 后续未发布」= 推进前线（强调色 indigo 加粗）；
 *   环降级断边 = 黄色虚线（amber，标黄提示）
 * - 视口：原生滚动条（overflow:auto），不做缩放、不做自定义平移（决策记录 #10）；
 *   进入时自动把推进前线区域滚进视口（无前线 → 回左上）
 * - 交互：点节点开详情；节点右缘手柄拖拽连线 = 建边（快捷入口，自研 pointer 逻辑，
 *   坐标 = 画布本地坐标；主入口在详情弹窗「前后关系」小节）；
 *   节点定位 revealNode（F5/F6 共用）：平移居中 + 一次性高亮
 * - 点亮提示（纯视图事件，不改写 dimmed 等任何数据，决策记录 #10）：items 变化时检测
 *   「全部前序刚进入已发布」的节点，播放一次光晕动画（reduced-motion 下不播）
 * - 未连线卡片暂存带（方案 1，PRD F4）：图视图底部横带，默认折叠只显计数；
 *   展开后原生横滚列出全部孤立卡（紧凑卡面：状态点 + 标题 + 日期；点击开详情）；
 *   暂存卡 ⇄ 图中节点双向拖线建边——方向规则与图内一致：拖出方 = 前序，落点 = 后续
 *   （onAddRelation(fromId, toId)），建边成功该卡即升入分层图、离开暂存带；
 *   孤立卡定位（搜索/分享/chip 跳转）= 展开暂存带 + 横滚居中 + 一次性高亮（替代 toast 降级）
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'
import type { ContentItem } from '@timeline/core/types'
import type { Orders } from '@timeline/core/board-view'
import { layoutGraph, type GraphLayout } from '@timeline/core/relation-core'
import { CardView } from './BoardCard'

export interface GraphApi {
  /** 定位节点：画布滚动居中 + 一次性高亮；节点不在图中（孤立卡）→ 返回 false */
  revealNode: (id: string) => boolean
}

interface BoardGraphProps {
  items: ContentItem[]
  orders: Orders
  apiRef: React.MutableRefObject<GraphApi | null>
  onOpenDetail: (id: string) => void
  /** 建边 fromId → toId（from 是前序）；自环/重复/不存在由上层幂等处理 */
  onAddRelation: (fromId: string, toId: string) => void
}

// 画布几何常量（节点 = 完整卡片固定槽位，层 = 列、层内纵向排；槽位尺寸大于卡片自然高度上限，
// 层间距/行距预留连线与箭头空间，边不穿过卡片）
const NODE_W = 240
const NODE_H = 190
const LAYER_W = 340 // 层间距（含连线空间）
const ROW_H = 232 // 层内行距
const PAD = 48
const HIGHLIGHT_MS = 1800
const LIT_MS = 1300

/** 关系图节点不挂卡片工具条：删除按钮不可达，传 noop 满足 CardView 必填签名 */
const noopDelete = () => undefined

interface Pos {
  x: number
  y: number
}

export default function BoardGraph({ items, orders, apiRef, onOpenDetail, onAddRelation }: BoardGraphProps) {
  const scrollerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLDivElement>(null)
  const [highlightId, setHighlightId] = useState<string | null>(null)
  const [litIds, setLitIds] = useState<ReadonlySet<string>>(new Set())
  const [connect, setConnect] = useState<{ fromId: string; ax: number; ay: number; x: number; y: number } | null>(
    null,
  )
  const [stageOpen, setStageOpen] = useState(false) // 未连线暂存带：默认折叠
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const itemById = useMemo(() => new Map(items.map((it) => [it.id, it])), [items])

  // 布局（纯 core 计算）+ 节点坐标（层内纵向居中）
  const layout: GraphLayout = useMemo(() => layoutGraph(items, orders), [items, orders])

  // 未连线孤立卡（无任何 pre/post 关系 = 不进分层图；暂存带数据，按日期 + orders 排序）
  const { orphans, orphanIds } = useMemo(() => {
    const inGraph = new Set(layout.nodes.map((n) => n.id))
    const list = items
      .filter((it) => !inGraph.has(it.id))
      .sort((a, b) => a.publish_at.localeCompare(b.publish_at) || (orders[a.id] ?? 0) - (orders[b.id] ?? 0))
    return { orphans: list, orphanIds: new Set(list.map((it) => it.id)) }
  }, [items, layout, orders])
  const { pos, canvasW, canvasH } = useMemo(() => {
    const layerCount = new Map<number, number>()
    for (const n of layout.nodes) layerCount.set(n.layer, (layerCount.get(n.layer) ?? 0) + 1)
    const maxRows = Math.max(1, ...layerCount.values())
    const h = maxRows * ROW_H + PAD * 2
    const w = (layout.maxLayer + 1) * LAYER_W + PAD * 2
    const m = new Map<string, Pos>()
    for (const n of layout.nodes) {
      const rows = layerCount.get(n.layer) ?? 1
      const offsetY = (h - rows * ROW_H) / 2
      m.set(n.id, { x: PAD + n.layer * LAYER_W, y: offsetY + n.index * ROW_H })
    }
    return { pos: m, canvasW: Math.max(w, 1), canvasH: h }
  }, [layout])

  /** 边渲染数据（含端点坐标与视觉分类） */
  const edgeViews = useMemo(
    () =>
      layout.edges
        .map((e) => {
          const a = pos.get(e.from)
          const b = pos.get(e.to)
          if (!a || !b) return null
          const fromItem = itemById.get(e.from)
          const toItem = itemById.get(e.to)
          // 推进前线：前序已发布 → 后续未发布
          const frontier = fromItem?.status === '已发布' && toItem?.status !== '已发布'
          return {
            key: `${e.from}→${e.to}`,
            x1: a.x + NODE_W,
            y1: a.y + NODE_H / 2,
            x2: b.x,
            y2: b.y + NODE_H / 2,
            broken: e.broken,
            frontier,
          }
        })
        .filter((x): x is NonNullable<typeof x> => x !== null),
    [layout, pos, itemById],
  )

  // 进入视图：自动把「推进前线」区域滚进视口（无前线 → 回左上）
  useEffect(() => {
    const scroller = scrollerRef.current
    if (!scroller) return
    const first = [...edgeViews].sort((a, b) => a.x1 - b.x1 || a.y1 - b.y1).find((e) => e.frontier)
    if (first) {
      const midX = (first.x1 + first.x2) / 2
      const midY = (first.y1 + first.y2) / 2
      scroller.scrollTo({
        left: Math.max(0, midX - scroller.clientWidth / 2),
        top: Math.max(0, midY - scroller.clientHeight / 2),
        behavior: 'auto',
      })
    } else {
      scroller.scrollTo({ left: 0, top: 0, behavior: 'auto' })
    }
    // 仅进入时执行一次（items 后续变化不重置视口）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ------------------------------------------------------------------
  // 定位（F5/F6/详情 chip 共用）：图内节点 = 滚动居中 + 一次性高亮；
  // 孤立卡（方案 1）= 展开暂存带 + 横滚居中 + 一次性高亮；都不存在 → false（上层 toast）
  // ------------------------------------------------------------------
  const revealNode = useCallback(
    (id: string): boolean => {
      const scroller = scrollerRef.current
      const p = pos.get(id)
      if (p && scroller) {
        if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current)
        setHighlightId(id)
        scroller.scrollTo({
          left: Math.max(0, p.x + NODE_W / 2 - scroller.clientWidth / 2),
          top: Math.max(0, p.y + NODE_H / 2 - scroller.clientHeight / 2),
          behavior: 'smooth',
        })
        highlightTimerRef.current = setTimeout(() => setHighlightId(null), HIGHLIGHT_MS)
        return true
      }
      if (orphanIds.has(id)) {
        if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current)
        setStageOpen(true)
        setHighlightId(id)
        highlightTimerRef.current = setTimeout(() => setHighlightId(null), HIGHLIGHT_MS)
        // 等暂存带展开渲染后横滚居中
        setTimeout(() => {
          document
            .querySelector(`[data-stage-card="${CSS.escape(id)}"]`)
            ?.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' })
        }, 60)
        return true
      }
      return false
    },
    [pos, orphanIds],
  )
  useEffect(() => {
    apiRef.current = { revealNode }
    return () => {
      apiRef.current = null
    }
  }, [apiRef, revealNode])
  useEffect(
    () => () => {
      if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current)
    },
    [],
  )

  // ------------------------------------------------------------------
  // 点亮提示（纯视图事件）：全部前序「刚进入已发布」的未发布节点播一次光晕。
  // 挂载时以当前 items 为基线（进视图不补播历史）；只播一次（lit 集合内不重复）。
  // ------------------------------------------------------------------
  const prevItemsRef = useRef(items)
  const litSeenRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    const prev = prevItemsRef.current
    prevItemsRef.current = items
    if (prev === items) return
    const prevById = new Map(prev.map((it) => [it.id, it]))
    const allPrePublished = (it: ContentItem, src: Map<string, ContentItem>): boolean => {
      const pres = it.pre_ids ?? []
      return pres.length > 0 && pres.every((pid) => src.get(pid)?.status === '已发布')
    }
    const nowById = new Map(items.map((it) => [it.id, it]))
    const newly: string[] = []
    for (const n of layout.nodes) {
      const it = nowById.get(n.id)
      if (!it || it.status === '已发布' || litSeenRef.current.has(n.id)) continue
      const before = prevById.get(n.id)
      if (!before) continue // 新卡不补播
      if (allPrePublished(it, nowById) && !allPrePublished(before, prevById)) newly.push(n.id)
    }
    if (newly.length === 0) return
    for (const id of newly) litSeenRef.current.add(id)
    setLitIds((s) => new Set([...s, ...newly]))
    const timer = setTimeout(() => {
      setLitIds((s) => {
        const next = new Set(s)
        for (const id of newly) next.delete(id)
        return next
      })
    }, LIT_MS)
    return () => clearTimeout(timer)
  }, [items, layout])

  // ------------------------------------------------------------------
  // 拖拽连线建边（快捷入口，自研 pointer 逻辑，画布本地坐标）：
  // 图节点/暂存卡右缘手柄 pointerdown → window 级 move/up；
  // 落点在图节点或暂存卡上 → 建边。方向规则（图内外一致）：拖出方 = 前序，落点 = 后续。
  // ------------------------------------------------------------------
  const canvasPoint = (e: PointerEvent): Pos => {
    const rect = canvasRef.current?.getBoundingClientRect()
    return { x: e.clientX - (rect?.left ?? 0), y: e.clientY - (rect?.top ?? 0) }
  }
  const startConnect = (fromId: string, e: React.PointerEvent) => {
    e.stopPropagation()
    e.preventDefault()
    const anchor = canvasPoint(e.nativeEvent)
    setConnect({ fromId, ax: anchor.x, ay: anchor.y, x: anchor.x, y: anchor.y })
    const onMove = (ev: PointerEvent) => {
      const pt = canvasPoint(ev)
      setConnect((c) => (c ? { ...c, x: pt.x, y: pt.y } : c))
    }
    const onUp = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      const el = document.elementFromPoint(ev.clientX, ev.clientY)
      const targetEl = el?.closest?.('[data-graph-node], [data-stage-card]')
      const toId = targetEl?.getAttribute('data-graph-node') ?? targetEl?.getAttribute('data-stage-card')
      if (toId && toId !== fromId) onAddRelation(fromId, toId)
      // 延迟清除连线态，吞掉紧随的 click（避免误开详情）
      setTimeout(() => setConnect(null), 0)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  return (
    // min-h-0 flex-1：与时间线容器对齐（h-full 会拿含 TopBar 的整页高度，把底缘滚动条顶出视口）
    <div className="flex min-h-0 flex-1 flex-col">
      <div ref={scrollerRef} className="min-h-0 flex-1 overflow-auto" data-graph-view>
        <div
          ref={canvasRef}
          className="relative"
          style={{ width: canvasW, height: canvasH, minWidth: '100%', minHeight: '100%' }}
        >
        {/* 边层：SVG 画布坐标（普通细线 / 推进前线强调色 / 环降级断边黄色虚线） */}
        <svg className="pointer-events-none absolute inset-0" width={canvasW} height={canvasH}>
          <defs>
            <marker id="graph-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
              <path d="M0,0 L8,4 L0,8 Z" fill="context-stroke" />
            </marker>
          </defs>
          {edgeViews.map((e) => {
            const dx = Math.max(48, Math.abs(e.x2 - e.x1) / 2)
            return (
              <path
                key={e.key}
                data-graph-edge={e.key}
                {...(e.broken ? { 'data-edge-broken': 'true' } : {})}
                {...(e.frontier ? { 'data-edge-frontier': 'true' } : {})}
                d={`M ${e.x1} ${e.y1} C ${e.x1 + dx} ${e.y1}, ${e.x2 - dx} ${e.y2}, ${e.x2} ${e.y2}`}
                fill="none"
                stroke={e.broken ? '#f59e0b' : e.frontier ? '#6366f1' : '#cbd5e1'}
                strokeWidth={e.frontier ? 2.5 : 1.5}
                strokeDasharray={e.broken ? '6 4' : undefined}
                markerEnd="url(#graph-arrow)"
              />
            )
          })}
          {/* 拖拽连线中的临时线（锚点 = 手柄按下处；暂存卡拖出时锚点在画布外，线随指针入画） */}
          {connect && (
            <line
              data-graph-connecting
              x1={connect.ax}
              y1={connect.ay}
              x2={connect.x}
              y2={connect.y}
              stroke="#6366f1"
              strokeWidth={2}
              strokeDasharray="4 3"
            />
          )}
        </svg>

        {/* 节点层：复用 BoardCard CardView 完整卡片面（视觉与时间线一致；toolbar 关闭，
            不挂 sortable——无层内排序拖拽；定位高亮/dimmed/bg_color 均由 CardView 承担） */}
        {layout.nodes.map((n) => {
          const it = itemById.get(n.id)
          const p = pos.get(n.id)
          if (!it || !p) return null
          return (
            <div
              key={n.id}
              data-graph-node={n.id}
              data-card-id={n.id}
              data-graph-layer={n.layer}
              data-graph-status={it.status}
              data-card-highlight={highlightId === n.id ? 'true' : undefined}
              className={['group absolute', litIds.has(n.id) ? 'graph-lit' : ''].join(' ')}
              style={{ left: p.x, top: p.y, width: NODE_W, height: NODE_H }}
            >
              <CardView
                card={it}
                onOpenDetail={() => onOpenDetail(n.id)}
                onDelete={noopDelete}
                highlighted={highlightId === n.id}
                toolbar={false}
                style={{ height: '100%' }}
              />
              {/* 右缘连线手柄（hover 显现；拖拽 = 以本卡为前序建边） */}
              <button
                type="button"
                data-edge-handle
                aria-label="拖拽连线建边"
                title="拖到另一张卡片建立「前序 → 后续」"
                onPointerDown={(e) => startConnect(n.id, e)}
                onClick={(e) => e.stopPropagation()}
                className="absolute -right-1.5 top-1/2 z-10 flex h-3.5 w-3.5 -translate-y-1/2 cursor-crosshair items-center justify-center rounded-full border border-indigo-300 bg-white opacity-0 shadow-sm transition-opacity duration-150 group-hover:opacity-100"
              >
                <span className="h-1 w-1 rounded-full bg-indigo-400" />
              </button>
            </div>
          )
        })}

        {/* 空图态：旧看板无关系字段 = 空图，正常打开（PRD 验收口径；引导从暂存带拖线建边） */}
        {layout.nodes.length === 0 && (
          <div
            data-graph-empty
            className="absolute inset-x-0 top-1/3 mx-auto w-fit rounded-2xl border border-dashed border-slate-200 bg-white/70 px-6 py-5 text-center"
          >
            <p className="text-sm text-slate-400">还没有卡片关系</p>
            <p className="mt-1 text-[11px] text-slate-300">
              展开下方「未连线卡片」暂存带，把卡片拖线到另一张卡即可建边
            </p>
            <p className="mt-0.5 text-[11px] text-slate-300">也可以在卡片详情「前后关系」小节添加前序/后续</p>
          </div>
        )}
        </div>
      </div>

      {/* 未连线卡片暂存带（方案 1）：默认折叠只显计数；展开原生横滚；点击开详情；
          右缘手柄拖线建边（拖出方 = 前序，落点 = 后续；建边后升入分层图） */}
      {orphans.length > 0 && (
        <div data-stage-band className="shrink-0 border-t border-slate-200/70 bg-white/85 backdrop-blur">
          <button
            type="button"
            data-stage-toggle
            onClick={() => setStageOpen((v) => !v)}
            className="flex w-full items-center gap-1.5 px-4 py-1.5 text-[12px] text-slate-500 transition-colors hover:text-indigo-600"
          >
            {stageOpen ? <ChevronDown className="size-3.5" /> : <ChevronUp className="size-3.5" />}
            未连线卡片 ({orphans.length})
            {!stageOpen && <span className="text-[11px] text-slate-300">点击展开，可拖线建边</span>}
          </button>
          {stageOpen && (
            <div data-stage-list className="flex gap-2 overflow-x-auto px-3 pb-2.5">
              {orphans.map((it) => (
                <div
                  key={it.id}
                  data-stage-card={it.id}
                  data-card-id={it.id}
                  data-card-highlight={highlightId === it.id ? 'true' : undefined}
                  onClick={() => onOpenDetail(it.id)}
                  className={[
                    'group relative w-44 shrink-0 cursor-pointer rounded-lg border border-slate-200/80 bg-white px-2.5 py-2 shadow-[0_1px_2px_rgba(15,23,42,0.06)] outline-none select-none',
                    'transition-[box-shadow,opacity,filter] duration-150 ease-out motion-reduce:transition-none',
                    'hover:shadow-[0_6px_14px_-6px_rgba(15,23,42,0.20)]',
                    it.dimmed === true ? 'opacity-[0.45] saturate-50' : '',
                    highlightId === it.id
                      ? 'ring-2 ring-indigo-400/90 shadow-[0_0_0_5px_rgba(129,140,248,0.20)]'
                      : '',
                  ].join(' ')}
                >
                  <div className="flex items-center gap-1.5">
                    <span
                      title={it.status}
                      className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                        it.status === '已发布' ? 'bg-emerald-500' : 'bg-slate-300'
                      }`}
                    />
                    <p className="line-clamp-2 text-[12px] font-semibold leading-snug text-slate-700">
                      {it.title || '未命名卡片'}
                    </p>
                  </div>
                  <p className="mt-1 text-[10px] tabular-nums text-slate-400">{it.publish_at.slice(0, 10)}</p>
                  {/* 右缘连线手柄（与图节点同款；拖拽 = 以本卡为前序建边） */}
                  <button
                    type="button"
                    data-edge-handle
                    aria-label="拖拽连线建边"
                    title="拖到另一张卡片建立「前序 → 后续」"
                    onPointerDown={(e) => startConnect(it.id, e)}
                    onClick={(e) => e.stopPropagation()}
                    className="absolute -right-1.5 top-1/2 z-10 flex h-3.5 w-3.5 -translate-y-1/2 cursor-crosshair items-center justify-center rounded-full border border-indigo-300 bg-white opacity-0 shadow-sm transition-opacity duration-150 group-hover:opacity-100"
                  >
                    <span className="h-1 w-1 rounded-full bg-indigo-400" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
