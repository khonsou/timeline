/**
 * 匿名评论（v2-M4）：CardComment 的校验 / 归一化 / 并发合并，三端共用同一口径。
 *
 * 三个入口对应三种场景：
 * - normalizeComments：写入口径（PATCH / change-set create·patch），严格校验，
 *   非法即整体拒绝（错误文案进 400）；null / 空串 / 空数组 → 空数组（清空语义，同 links）。
 * - sanitizeComments：读取兜底（web 加载 doc 进 React 前），宽松清洗——
 *   非数组 → undefined（移除字段）；逐条剔除非法项；清洗后为空 → undefined。
 * - mergeCommentsById：web 同步层 409 重放专用——整组字段级 LWW 会让「两人同时评论
 *   同一张卡」丢一条，重放时按 id 键控 union（同 id 以 base/远端为准），按 created_at 升序。
 *
 * 本文件保持纯 TypeScript（erasable 类型标注），不依赖 DOM / Node API。
 */
import type { CardComment } from '../types/content.ts'

/** 单条评论形状校验 + 归一化；非法返回 null（id/body/created_at 必填非空，author 可空串/缺省） */
const toComment = (el: unknown): CardComment | null => {
  if (!el || typeof el !== 'object' || Array.isArray(el)) return null
  const rec = el as Record<string, unknown>
  const id = typeof rec.id === 'string' ? rec.id.trim() : ''
  const body = typeof rec.body === 'string' ? rec.body : ''
  const created_at = typeof rec.created_at === 'string' ? rec.created_at.trim() : ''
  if (!id || !body.trim() || !created_at) return null
  const author = typeof rec.author === 'string' ? rec.author.trim() : ''
  return { id, author, body, created_at }
}

/**
 * 写入口径（严格）：须为数组（null / 空串 → 空数组，语义 = 清空）；
 * 元素须为含非空 id / body / created_at 的对象，author 须为字符串（可空串，缺省视为未署名 ''）。
 * 归一化：id/created_at/author trim；body 保留原样（换行/首尾空格属内容）。
 */
export function normalizeComments(raw: unknown): { value: CardComment[]; error?: string } {
  if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) return { value: [] }
  if (!Array.isArray(raw)) return { value: [], error: `comments 须为数组，得到 ${JSON.stringify(raw)}` }
  const out: CardComment[] = []
  for (const [i, el] of raw.entries()) {
    if (!el || typeof el !== 'object' || Array.isArray(el)) {
      return { value: [], error: `comments[${i}] 须为对象（含 id / body / created_at）` }
    }
    const rec = el as Record<string, unknown>
    if (rec.author !== undefined && typeof rec.author !== 'string') {
      return { value: [], error: `comments[${i}].author 须为字符串（可空串）` }
    }
    const c = toComment(rec)
    if (!c) return { value: [], error: `comments[${i}] 非法：id / body / created_at 必填且非空` }
    out.push(c)
  }
  return { value: out }
}

/**
 * 读取兜底（宽松）：undefined / 非数组 → undefined（字段移除，保持 doc 干净）；
 * 数组逐条清洗（非法项丢弃），清洗后为空 → undefined。
 */
export function sanitizeComments(raw: unknown): CardComment[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const out: CardComment[] = []
  for (const el of raw) {
    const c = toComment(el)
    if (c) out.push(c)
  }
  return out.length > 0 ? out : undefined
}

/**
 * id 键控合并（409 重放专用）：union by id——base（远端快照）与 incoming（本地 pending）
 * 双方独有的评论都保留；同 id 以 base（远端）为准；结果按 created_at 升序。
 * 双方皆空 → undefined（字段移除）。
 * 已知取舍：本地「删除评论」在冲突重放时可能被远端快照复活（无 tombstone 无法区分
 * 「本地删了」与「远端新增」）——评论区宁可多留一条，也不静默丢评论。
 */
export function mergeCommentsById(
  base: CardComment[] | undefined,
  incoming: CardComment[] | undefined,
): CardComment[] | undefined {
  if (!base?.length && !incoming?.length) return undefined
  const byId = new Map<string, CardComment>()
  for (const c of incoming ?? []) byId.set(c.id, c)
  for (const c of base ?? []) byId.set(c.id, c) // base 后写：同 id 以远端为准
  const out = [...byId.values()]
  out.sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0))
  return out.length > 0 ? out : undefined
}
