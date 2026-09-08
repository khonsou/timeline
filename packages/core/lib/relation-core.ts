/**
 * 卡片关系（v2-M3 F4 多对多依赖图）核心规则（纯函数，core 唯一定义，三端复用）
 *
 * 数据模型（PRD F4，2026-09-08 终稿）：
 * - 有向边 predecessor → successor 落在卡片自有字段上（与 Asana dependencies/dependents、
 *   Notion 双向 relation 同构）；多对多、允许成环（环由视图层降级处理，数据层不禁止）
 * - **单一写入源铁律**：pre_ids 是唯一可写字段；post_ids 是 core 镜像（外部只读）
 *   不变量：A.post_ids ∋ B ⇔ B.pre_ids ∋ A
 * - 写入严格：pre_ids 元素逐个校验为板内存在的卡片 id；自环拒绝；重复 id 去重（保序）；
 *   直接 patch post_ids → 400（patch-core 白名单不含它，自动拒绝）
 * - 删卡级联：从所有相关卡的 pre_ids / post_ids 中剔除该 id（同一事务内）
 * - 读取宽松（加载兜底）：悬空 id 剔除，并按 pre_ids 全量重建 post_ids 镜像
 *
 * 视图层支持：
 * - relationEdges：从 pre_ids 派生边集（唯一写入源即真相）
 * - layoutGraph：longest-path 分层布局（节点层 = 最长前序链长度；层内按 orders 横排）；
 *   遇环降级——打断环上「目标节点入度最小」的一条边（平局取先遇到者），该边不参与
 *   分层并在结果里标 broken（视图标黄提示）；重复断边直到无环，输出保证是 DAG 分层
 *
 * 本文件保持纯 TypeScript（含 erasable 类型标注），不依赖 DOM / Node API，
 * 不改写传入的 items（所有返回新数组/新对象；未变化的卡片保留原引用，利于渲染 memo）。
 */
import type { ContentItem } from '../types/content'
import type { Orders } from './board-view.ts'

/** pre_ids 格式校验 + 归一化：须为字符串数组；元素 trim、非空；重复 id 去重（保序） */
export function normalizePreIds(raw: unknown): { value?: string[]; error?: string } {
  if (!Array.isArray(raw)) {
    return { error: `pre_ids 非法: 期望卡片 id 数组，实际 ${JSON.stringify(raw)}` }
  }
  const out: string[] = []
  for (const el of raw) {
    if (typeof el !== 'string' || !el.trim()) {
      return { error: `pre_ids 元素非法: ${JSON.stringify(el)}（须为非空卡片 id 字符串）` }
    }
    const v = el.trim()
    if (!out.includes(v)) out.push(v) // 重复 id 去重（保序，不报错）
  }
  return { value: out }
}

/**
 * pre_ids 引用校验（格式已通过 normalizePreIds）：
 * - 自环拒绝（元素 === 卡片自身 id）
 * - strictIds 提供时逐个校验存在性（写入严格 400；缺省 = 无看板上下文的预校验，只查格式）
 */
export function validatePreIdRefs(preIds: string[], selfId: string, strictIds?: Set<string>): string[] {
  const errors: string[] = []
  if (preIds.includes(selfId)) {
    errors.push('pre_ids 不允许自环（卡片不能是自己的前序）')
  }
  if (strictIds) {
    const missing = preIds.filter((x) => !strictIds.has(x))
    if (missing.length > 0) errors.push(`pre_ids 指向不存在的卡片: ${missing.join(', ')}`)
  }
  return errors
}

/** 镜像更新条目：某张卡（非被编辑卡）的 post_ids 需要变化；new_post_ids 缺省 = 移除字段 */
export interface MirrorUpdate {
  id: string
  old_post_ids?: string[]
  new_post_ids?: string[]
}

/**
 * pre_ids 变更（oldPre → newPre）→ 计算受影响卡片的 post_ids 镜像差分。
 * 只产出真正变化的卡片；数组尾部追加新增、移除后空数组 → 字段移除（保持 doc 干净）。
 */
export function diffPostMirror(
  items: ContentItem[],
  itemId: string,
  oldPre: readonly string[],
  newPre: readonly string[],
): MirrorUpdate[] {
  const added = newPre.filter((x) => !oldPre.includes(x))
  const removed = oldPre.filter((x) => !newPre.includes(x))
  if (added.length === 0 && removed.length === 0) return []
  const updates: MirrorUpdate[] = []
  for (const pid of added) {
    const target = items.find((it) => it.id === pid)
    if (!target) continue // 防御：写入路径已校验存在性；读取兜底场景静默跳过
    const cur = target.post_ids ?? []
    if (cur.includes(itemId)) continue
    updates.push({ id: pid, old_post_ids: target.post_ids, new_post_ids: [...cur, itemId] })
  }
  for (const pid of removed) {
    const target = items.find((it) => it.id === pid)
    if (!target) continue
    const cur = target.post_ids ?? []
    if (!cur.includes(itemId)) continue
    const nxt = cur.filter((x) => x !== itemId)
    updates.push({ id: pid, old_post_ids: target.post_ids, new_post_ids: nxt.length ? nxt : undefined })
  }
  return updates
}

/** 把镜像差分应用到 items（不改写入参；仅受影响卡片生成新对象） */
export function applyMirrorUpdates(items: ContentItem[], updates: readonly MirrorUpdate[]): ContentItem[] {
  if (updates.length === 0) return items
  const byId = new Map(updates.map((u) => [u.id, u]))
  return items.map((it) => {
    const u = byId.get(it.id)
    if (!u) return it
    const next = { ...it }
    if (u.new_post_ids && u.new_post_ids.length > 0) next.post_ids = u.new_post_ids
    else delete next.post_ids
    return next
  })
}

/** 写 pre_ids 的数组落盘口径：空数组 = 移除字段（保持 doc 干净，与 group_id 移除语义一致） */
export function withPreIdsField(item: ContentItem, preIds: readonly string[]): ContentItem {
  const next = { ...item }
  if (preIds.length > 0) next.pre_ids = [...preIds]
  else delete next.pre_ids
  return next
}

/**
 * 设置某卡的 pre_ids 并同步镜像（GUI 详情弹窗/拖拽建边共用的本地写路径）：
 * 返回新 items（镜像受影响的卡片一并更新）；卡片不存在 → 原样返回。
 * 调用方需先过 normalizePreIds + validatePreIdRefs（GUI 内部构造可信赖本函数不再拒绝）。
 */
export function withPreIds(items: ContentItem[], id: string, preIds: readonly string[]): ContentItem[] {
  const target = items.find((it) => it.id === id)
  if (!target) return items
  const updates = diffPostMirror(items, id, target.pre_ids ?? [], preIds)
  const mirrored = applyMirrorUpdates(items, updates)
  return mirrored.map((it) => (it.id === id ? withPreIdsField(it, preIds) : it))
}

/** 建边 preId → postId（自环 / 已存在 / 卡不存在 → 原样返回，幂等） */
export function withAddedRelation(items: ContentItem[], preId: string, postId: string): ContentItem[] {
  if (preId === postId) return items
  const target = items.find((it) => it.id === postId)
  if (!target || !items.some((it) => it.id === preId)) return items
  const cur = target.pre_ids ?? []
  if (cur.includes(preId)) return items
  return withPreIds(items, postId, [...cur, preId])
}

/** 删边 preId → postId（不存在 → 原样返回，幂等） */
export function withRemovedRelation(items: ContentItem[], preId: string, postId: string): ContentItem[] {
  const target = items.find((it) => it.id === postId)
  if (!target) return items
  const cur = target.pre_ids ?? []
  if (!cur.includes(preId)) return items
  return withPreIds(items, postId, cur.filter((x) => x !== preId))
}

/** 删卡级联：从所有相关卡的 pre_ids / post_ids 剔除被删 id（同事务语义） */
export function cascadeDeleteRelations(items: ContentItem[], deletedIds: ReadonlySet<string>): ContentItem[] {
  return items.map((it) => {
    if (deletedIds.has(it.id)) return it // 被删卡本身由调用方剔除
    const pre = it.pre_ids
    const post = it.post_ids
    const preHit = pre?.some((x) => deletedIds.has(x)) ?? false
    const postHit = post?.some((x) => deletedIds.has(x)) ?? false
    if (!preHit && !postHit) return it
    const next = { ...it }
    if (preHit) {
      const nxt = pre!.filter((x) => !deletedIds.has(x))
      if (nxt.length) next.pre_ids = nxt
      else delete next.pre_ids
    }
    if (postHit) {
      const nxt = post!.filter((x) => !deletedIds.has(x))
      if (nxt.length) next.post_ids = nxt
      else delete next.post_ids
    }
    return next
  })
}

/**
 * 读取兜底（加载校验用）：剔除悬空 id（指向不存在卡片 / 自环 / 重复），
 * 并按 pre_ids 全量重建 post_ids 镜像。引用稳定：无变化时返回原数组（卡片原对象）。
 */
export function normalizeRelationFields(items: ContentItem[]): ContentItem[] {
  const ids = new Set(items.map((it) => it.id))
  // 1. pre_ids 清洗（悬空/自环/重复）
  const cleaned = items.map((it) => {
    if (it.pre_ids === undefined) return it
    const ok = it.pre_ids.filter((x, i) => ids.has(x) && x !== it.id && it.pre_ids!.indexOf(x) === i)
    if (ok.length === (it.pre_ids?.length ?? 0)) return it
    return withPreIdsField(it, ok)
  })
  // 2. 按 pre_ids 重建 post_ids 镜像（唯一写入源 = 真相）
  const mirror = new Map<string, string[]>()
  for (const it of cleaned) {
    for (const pid of it.pre_ids ?? []) {
      const arr = mirror.get(pid)
      if (arr) arr.push(it.id)
      else mirror.set(pid, [it.id])
    }
  }
  return cleaned.map((it) => {
    const want = mirror.get(it.id)
    const cur = it.post_ids
    const same =
      want === undefined
        ? cur === undefined
        : cur !== undefined && cur.length === want.length && cur.every((x, i) => x === want[i])
    if (same) return it
    const next = { ...it }
    if (want) next.post_ids = want
    else delete next.post_ids
    return next
  })
}

// ---------------------------------------------------------------------------
// 关系图视图支持（BoardGraph）：边集派生 + longest-path 分层布局（遇环断边降级）
// ---------------------------------------------------------------------------

export interface GraphEdge {
  /** 前序卡片 id（边起点） */
  from: string
  /** 后续卡片 id（边终点） */
  to: string
  /** true = 成环降级被打断的边（不参与分层，视图标黄提示） */
  broken: boolean
}

/** 从 pre_ids（唯一写入源）派生边集；只含两端都存在的边；重复边去重 */
export function relationEdges(items: ContentItem[]): GraphEdge[] {
  const ids = new Set(items.map((it) => it.id))
  const edges: GraphEdge[] = []
  const seen = new Set<string>()
  for (const it of items) {
    for (const pid of it.pre_ids ?? []) {
      if (!ids.has(pid) || pid === it.id) continue
      const key = `${pid}→${it.id}`
      if (seen.has(key)) continue
      seen.add(key)
      edges.push({ from: pid, to: it.id, broken: false })
    }
  }
  return edges
}

export interface GraphLayoutNode {
  id: string
  /** 层 = 最长前序链长度（0 = 无前序） */
  layer: number
  /** 层内序号（按 orders 升序，同序按 id 字典序稳定） */
  index: number
}

export interface GraphLayout {
  /** 参与图布局的节点（至少有一条边的卡片；无关系卡不进图） */
  nodes: GraphLayoutNode[]
  /** 全量边（含 broken 断边，供视图标黄渲染） */
  edges: GraphEdge[]
  /** 最大层号（无节点时 -1） */
  maxLayer: number
}

/**
 * longest-path 分层布局：
 * 1. 节点 = 至少有一条关系的卡片（pre 或 post 非空）；
 * 2. 遇环降级——DFS 找环，打断环上「目标节点在当前边集下入度最小」的一条边
 *   （平局取先遇到者），标记 broken 不参与分层；重复直到无环（有迭代上限兜底）；
 * 3. 层号 = 未断边构成的 DAG 上「最长前序链长度」（记忆化 DFS）；
 * 4. 层内按 orders 升序横排（只读反映；图视图内不做层内拖拽排序）。
 */
export function layoutGraph(items: ContentItem[], orders: Orders): GraphLayout {
  const networked = items.filter((it) => (it.pre_ids?.length ?? 0) > 0 || (it.post_ids?.length ?? 0) > 0)
  const nodeIds = new Set(networked.map((it) => it.id))
  const edges = relationEdges(items).filter((e) => nodeIds.has(e.from) && nodeIds.has(e.to))
  if (networked.length === 0) return { nodes: [], edges, maxLayer: -1 }

  // 断边降级：active = 参与分层的边
  const active = new Set(edges.map((_, i) => i))
  const inDegreeOf = (id: string): number => {
    let n = 0
    for (const [i, e] of edges.entries()) if (active.has(i) && e.to === id) n++
    return n
  }
  const MAX_BREAKS = edges.length + 1 // 每次至少断一条，理论上限边数
  for (let guard = 0; guard < MAX_BREAKS; guard++) {
    // DFS 三色标记找一条环路径
    const adj = new Map<string, number[]>() // from → active 边索引
    for (const [i, e] of edges.entries()) {
      if (!active.has(i)) continue
      const arr = adj.get(e.from)
      if (arr) arr.push(i)
      else adj.set(e.from, [i])
    }
    const color = new Map<string, number>() // 0=未访 1=在栈 2=完成
    let cycleEdgeIdx: number[] | null = null
    const stack: number[] = [] // 当前路径上的边索引
    const visit = (u: string): boolean => {
      color.set(u, 1)
      for (const ei of adj.get(u) ?? []) {
        const e = edges[ei]
        const c = color.get(e.to) ?? 0
        if (c === 0) {
          stack.push(ei)
          if (visit(e.to)) return true
          stack.pop()
        } else if (c === 1) {
          // 找到环：栈中从指向 e.to 的边开始的所有边 + 当前边构成环路径
          const start = stack.findIndex((x) => edges[x].from === e.to)
          cycleEdgeIdx = [...(start >= 0 ? stack.slice(start) : stack), ei]
          return true
        }
      }
      color.set(u, 2)
      return false
    }
    let found = false
    for (const n of nodeIds) {
      if ((color.get(n) ?? 0) === 0 && visit(n)) {
        found = true
        break
      }
    }
    if (!found) break // 已无环
    // 打断环上「目标入度最小」的边（平局取先遇到者）
    let victim = cycleEdgeIdx![0]
    let victimDeg = inDegreeOf(edges[victim].to)
    for (const ei of cycleEdgeIdx!.slice(1)) {
      const d = inDegreeOf(edges[ei].to)
      if (d < victimDeg) {
        victim = ei
        victimDeg = d
      }
    }
    active.delete(victim)
    edges[victim] = { ...edges[victim], broken: true }
  }

  // 最长前序链（记忆化 DFS，active 边已是 DAG）
  const inEdges = new Map<string, string[]>() // to → from[]
  for (const [i, e] of edges.entries()) {
    if (!active.has(i)) continue
    const arr = inEdges.get(e.to)
    if (arr) arr.push(e.from)
    else inEdges.set(e.to, [e.from])
  }
  const layerMemo = new Map<string, number>()
  const layerOf = (id: string): number => {
    const memo = layerMemo.get(id)
    if (memo !== undefined) return memo
    let layer = 0
    for (const from of inEdges.get(id) ?? []) {
      layer = Math.max(layer, layerOf(from) + 1)
    }
    layerMemo.set(id, layer)
    return layer
  }
  const byLayer = new Map<number, string[]>()
  let maxLayer = 0
  for (const it of networked) {
    const layer = layerOf(it.id)
    maxLayer = Math.max(maxLayer, layer)
    const arr = byLayer.get(layer)
    if (arr) arr.push(it.id)
    else byLayer.set(layer, [it.id])
  }
  const nodes: GraphLayoutNode[] = []
  for (const [layer, ids] of byLayer) {
    ids.sort((a, b) => (orders[a] ?? 0) - (orders[b] ?? 0) || (a < b ? -1 : a > b ? 1 : 0))
    ids.forEach((id, index) => nodes.push({ id, layer, index }))
  }
  return { nodes, edges, maxLayer }
}
