/**
 * 共享导入核心：JSON/CSV 解析（RFC4180）、中文别名映射、逐行校验归一化、
 * 内容哈希 id（纯 TS 实现 SHA-1）、orders 计算、产品目录差分合并（mergeProducts）。
 *
 * 纯 TypeScript、无 Node API 依赖（TextEncoder/DataView 为跨端 Web API）：
 * - CLI：scripts/import-data.mjs 以 `import ... from '../src/lib/import-core.ts'`
 *   直接引用（Node 24 原生 strip-types，仅可擦除语法：无 enum / 命名空间 / 参数属性）
 * - 应用内「卡片增量导入」：src/App.tsx 经 vite 引用（'@/lib/import-core'）
 *
 * 注意：本文件内只允许相对路径 import（Node 裸跑不认识 '@/‘ 别名）。
 */
import type { ContentItem, ContentStatus, Member } from '../types/content'

export interface ProductInput {
  id: string
  name: string
}

export interface ItemsInput {
  records: Record<string, unknown>[]
  products?: ProductInput[]
}

export interface SkippedRow {
  row: string
  reason: string
}

export interface ValidateItemsOptions {
  isCsv: boolean
  knownProducts: Set<string>
  /** 现有成员目录 姓名→id（负责人按姓名解析；未知姓名自动登记为新成员） */
  knownMembers: Map<string, string>
  /** 当前时间键 YYYY-MM-DDTHH:mm（status 缺省推导 / 未发布统计用），由调用方注入 */
  now: string
  /** true 时遇第一个无效行抛 StrictRowSignal（CLI --strict；UI 不用） */
  strict?: boolean
}

export interface ValidateItemsResult {
  valid: ContentItem[]
  skipped: SkippedRow[]
  /** 未知 product_id 的自动登记清单（name 缺省用 id 占位；内嵌 products 中已有的 id 不重复收集） */
  productHints: ProductInput[]
  /** 未知负责人姓名的自动登记清单（按姓名；同姓名多行复用同一新 id） */
  memberHints: Member[]
  emptyProductCount: number // 未填写归属产品（置 ''，UI 显示「不明」）
  forcedNullCount: number // status ≠ 已发布但原本带了指标值的条数
}

export interface MergeProductsResult {
  merged: ProductInput[]
  added: number // incoming 中的新 id 追加数
  updated: number // 同 id 但 name 不同的更新数
  unchanged: number // 同 id 同 name 的保留数
}

/**
 * 产品目录差分合并（v13：导入只能加/改产品，永不删除；删除走页面「产品管理」）：
 * 同 id → name 不同则更新（updated），相同则保留（unchanged）；
 * 新 id → 追加（added）；existing 中 incoming 未提及的条目原样保留。
 * 合并满足结合序：mergeProducts(mergeProducts(E, H), P) ≡ mergeProducts(E, mergeProducts(H, P).merged)
 * （H 与 P 有同 id 时 P 的 name 优先——调用方借此让内嵌 products 覆盖 hint 占位名）
 *
 * 占位名保护：incoming 的 name === id 时视为「未知 id 的缺省占位名」（validateItems 的
 * productHints 缺省生成），即使与既有名称不同也不覆盖（计 unchanged）——CLI 的已知目录
 * 只是浏览器本地目录的近似，占位名永远不能clobber任何真实名称；产品真要以 id 为名，
 * 用产品文件 / 产品管理显式改成 id 之外的写法再改回即可（极端场景，有意不支持）。
 */
export function mergeProducts(existing: ProductInput[], incoming: ProductInput[]): MergeProductsResult {
  const merged = existing.map((p) => ({ id: p.id, name: p.name }))
  const index = new Map(merged.map((p, i) => [p.id, i]))
  let added = 0
  let updated = 0
  let unchanged = 0
  for (const p of incoming) {
    const i = index.get(p.id)
    if (i === undefined) {
      index.set(p.id, merged.length)
      merged.push({ id: p.id, name: p.name })
      added++
    } else if (merged[i].name === p.name || p.name === p.id) {
      unchanged++ // 同名保留；占位名（name===id）不覆盖既有名称
    } else {
      merged[i] = { id: p.id, name: p.name }
      updated++
    }
  }
  return { merged, added, updated, unchanged }
}

export interface MergeMembersResult {
  merged: Member[]
  added: number // incoming 中的新姓名追加数
  unchanged: number // 同名复用既有 id 的数量
}

/**
 * 成员目录差分合并（与 mergeProducts 同哲学，但**匹配键是姓名**）：
 * incoming 姓名在 existing 中已存在 → 复用既有 id（unchanged，条目不变）；
 * 新姓名 → 按 incoming 给的 id 追加（added）；existing 未提及的一律保留
 * （导入只能加成员、不能删——删成员走页面「成员管理」）。
 * 姓名即键决定了不存在「更新」维度（同名不同 id 时永远复用既有 id）。
 */
export function mergeMembers(existing: Member[], incoming: Member[]): MergeMembersResult {
  const merged = existing.map((m) => ({ id: m.id, name: m.name }))
  const byName = new Map(merged.map((m, i) => [m.name, i]))
  let added = 0
  let unchanged = 0
  for (const m of incoming) {
    const i = byName.get(m.name)
    if (i !== undefined) {
      unchanged++
    } else {
      byName.set(m.name, merged.length)
      merged.push({ id: m.id, name: m.name })
      added++
    }
  }
  return { merged, added, unchanged }
}

export interface ValidateProductsOptions {
  isCsv: boolean
  strict?: boolean
}

export interface ValidateProductsResult {
  valid: ProductInput[]
  skipped: SkippedRow[]
}

/** --strict 遇错即停信号（抛出对象为纯字面量，调用方用 isStrictRowSignal 判定） */
export interface StrictRowSignal {
  strictRow: true
  row: string
  reason: string
}
export function isStrictRowSignal(e: unknown): e is StrictRowSignal {
  return !!e && typeof e === 'object' && (e as StrictRowSignal).strictRow === true
}

export const TYPES = ['图文', '视频', '音频', '直播', '数据'] as const

/** 内容状态枚举（与 types/content.ts 的 ContentStatus 一致；运行时校验用） */
export const STATUSES: readonly ContentStatus[] = ['待执行', '待发布', '已发布']

// 中文表头/字段别名 → ContentItem 英文字段
const ALIAS: Record<string, string> = {
  标题: 'title',
  类型: 'type',
  计划发布时间: 'publish_at',
  状态: 'status', // v14：内容状态（待执行/待发布/已发布），缺省按 publish_at 推导
  备注: 'comment',
  产品ID: 'product_id',
  产品名: 'product_name', // 卡片行可选携带产品名：未知 product_id 自动登记进目录时用作名称
  产品名称: 'product_name',
  内容负责人: 'content_owner', // 按姓名填写：目录命中复用 id，未知姓名自动登记（memberHints）
  投放负责人: 'delivery_owner',
  ROI: 'roi',
  曝光4h: 'propagation_4h',
  互动4h: 'engagement_4h',
}
const FIELD_KEYS = [
  'id', 'title', 'type', 'publish_at', 'status', 'roi', 'comment',
  'product_id', 'product_name', 'content_owner', 'delivery_owner',
  'propagation_4h', 'engagement_4h',
]

// 产品文件表头别名 → id / name
const PRODUCT_ALIAS: Record<string, string> = {
  id: 'id',
  产品ID: 'id',
  产品编号: 'id',
  name: 'name',
  产品名: 'name',
  产品名称: 'name',
  名称: 'name',
}

// ---------------------------------------------------------------------------
// CSV 解析（RFC4180 迷你解析器：引号包裹、双引号转义、字段内逗号/换行；兼容 BOM）
// ---------------------------------------------------------------------------
export function parseCsv(text: string): string[][] {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1) // BOM
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else inQuotes = false
      } else field += ch
    } else if (ch === '"') inQuotes = true
    else if (ch === ',') {
      row.push(field)
      field = ''
    } else if (ch === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else if (ch === '\r') {
      // 忽略，\n 统一断行
    } else field += ch
  }
  if (field !== '' || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

function normalizeKeys(rec: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(rec)) {
    const key = ALIAS[k.trim()] ?? k.trim()
    if (FIELD_KEYS.includes(key)) out[key] = v
  }
  return out
}

/** items 输入解析（纯函数：text + 扩展名 → 记录数组 + 可选内嵌产品目录） */
export function readItemsInput(text: string, ext: string): ItemsInput {
  if (ext === '.json') {
    const data = JSON.parse(text)
    if (Array.isArray(data))
      return { records: data.map(normalizeKeys), products: undefined }
    if (data && Array.isArray(data.items)) {
      // { items: [...], products?: [...] } 包裹形式
      let products: ProductInput[] | undefined
      if (Array.isArray(data.products)) {
        products = []
        for (const [i, p] of data.products.entries()) {
          if (!p || typeof p.id !== 'string' || typeof p.name !== 'string' || !p.id || !p.name) {
            throw new Error(`products[${i}] 非法：需要 { id: string, name: string }`)
          }
          products.push({ id: p.id, name: p.name })
        }
      }
      return { records: data.items.map(normalizeKeys), products }
    }
    throw new Error('JSON 须为记录数组，或 { items: [...], products?: [...] } 包裹形式')
  }
  if (ext === '.csv') {
    const rows = parseCsv(text)
    if (rows.length < 1) throw new Error('CSV 为空')
    const header = rows[0].map((h) => h.trim())
    const records = rows.slice(1).map((r) => {
      const rec: Record<string, unknown> = {}
      header.forEach((h, i) => {
        if (h) rec[h] = r[i] ?? ''
      })
      return normalizeKeys(rec)
    })
    return { records, products: undefined }
  }
  throw new Error(`不支持的文件类型: ${ext}（仅 .json / .csv）`)
}

function normalizeProductKeys(rec: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(rec ?? {})) {
    const key = PRODUCT_ALIAS[String(k).trim()] ?? String(k).trim()
    if (key === 'id' || key === 'name') out[key] = v
  }
  return out
}

/** 产品文件输入解析（纯函数）：JSON 产品数组 / { products } 包裹 / CSV 表头别名 */
export function readProductsInput(text: string, ext: string): Record<string, unknown>[] {
  if (ext === '.json') {
    const data = JSON.parse(text)
    const arr = Array.isArray(data) ? data : Array.isArray(data?.products) ? data.products : null
    if (!arr) throw new Error('JSON 须为产品数组，或 { products: [...] } 包裹形式')
    return arr.map((p: unknown) =>
      normalizeProductKeys(p && typeof p === 'object' ? (p as Record<string, unknown>) : {}),
    )
  }
  if (ext === '.csv') {
    const rows = parseCsv(text)
    if (rows.length < 1) throw new Error('CSV 为空')
    const header = rows[0].map((h) => h.trim())
    return rows.slice(1).map((r) => {
      const rec: Record<string, unknown> = {}
      header.forEach((h, i) => {
        if (h) rec[h] = r[i] ?? ''
      })
      return normalizeProductKeys(rec)
    })
  }
  throw new Error(`不支持的文件类型: ${ext}（仅 .json / .csv）`)
}

// ---------------------------------------------------------------------------
// 字段归一化
// ---------------------------------------------------------------------------
const pad = (n: number) => String(n).padStart(2, '0')

/** 接受 YYYY-MM-DDTHH:mm / YYYY-MM-DD HH:mm / YYYY/M/D H:mm（可带秒），归一化为 YYYY-MM-DDTHH:mm */
export function normalizePublishAt(raw: unknown): string | null {
  const m = String(raw ?? '')
    .trim()
    .match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})[T ](\d{1,2}):(\d{1,2})(?::\d{1,2})?$/)
  if (!m) return null
  const [, y, mo, d, h, mi] = m.map(Number)
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return null
  const dt = new Date(y, mo - 1, d)
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null
  return `${y}-${pad(mo)}-${pad(d)}T${pad(h)}:${pad(mi)}`
}

/** 空 → null；非负数字 → number；其余报错 */
function normalizeMetric(raw: unknown, name: string): { value: number | null; error?: string } {
  if (raw === undefined || raw === null || String(raw).trim() === '') return { value: null }
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0)
    return { value: null, error: `${name} 须为空或非负数字，得到 "${raw}"` }
  return { value: n }
}

// ---------------------------------------------------------------------------
// 纯 TS SHA-1（与 node:crypto createHash('sha1') 输出一致；供内容哈希 id 跨端共用）
// ---------------------------------------------------------------------------
export function sha1Hex(text: string): string {
  const bytes = new TextEncoder().encode(text)
  const bitLen = bytes.length * 8
  const padded = Math.ceil((bytes.length + 1 + 8) / 64) * 64
  const buf = new Uint8Array(padded)
  buf.set(bytes)
  buf[bytes.length] = 0x80
  const dv = new DataView(buf.buffer)
  dv.setUint32(padded - 4, bitLen >>> 0, false)
  dv.setUint32(padded - 8, Math.floor(bitLen / 0x100000000), false)
  let h0 = 0x67452301
  let h1 = 0xefcdab89
  let h2 = 0x98badcfe
  let h3 = 0x10325476
  let h4 = 0xc3d2e1f0
  const w = new Uint32Array(80)
  const rol = (v: number, n: number) => ((v << n) | (v >>> (32 - n))) >>> 0
  for (let off = 0; off < padded; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4, false)
    for (let i = 16; i < 80; i++) w[i] = rol(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1)
    let a = h0
    let b = h1
    let c = h2
    let d = h3
    let e = h4
    for (let i = 0; i < 80; i++) {
      let f: number
      let k: number
      if (i < 20) {
        f = (b & c) | (~b & d)
        k = 0x5a827999
      } else if (i < 40) {
        f = b ^ c ^ d
        k = 0x6ed9eba1
      } else if (i < 60) {
        f = (b & c) | (b & d) | (c & d)
        k = 0x8f1bbcdc
      } else {
        f = b ^ c ^ d
        k = 0xca62c1d6
      }
      const tmp = (rol(a, 5) + f + e + k + w[i]) >>> 0
      e = d
      d = c
      c = rol(b, 30)
      b = a
      a = tmp
    }
    h0 = (h0 + a) >>> 0
    h1 = (h1 + b) >>> 0
    h2 = (h2 + c) >>> 0
    h3 = (h3 + d) >>> 0
    h4 = (h4 + e) >>> 0
  }
  return [h0, h1, h2, h3, h4].map((h) => h.toString(16).padStart(8, '0')).join('')
}

/** 内容哈希确定性 id：同一行数据每次导入得到同一个 id（--merge / UI 增量导入幂等的保证） */
export function autoId(title: string, type: string, publishAt: string, productId: string): string {
  return `auto-${sha1Hex(`${title}|${type}|${publishAt}|${productId}`).slice(0, 16)}`
}

// ---------------------------------------------------------------------------
// orders 计算：按日期分组，组内按 publish_at 时分排序赋 0,1,2…
// ---------------------------------------------------------------------------
export function computeOrders(items: { id: string; publish_at: string }[]): Record<string, number> {
  const groups = new Map<string, { id: string; publish_at: string }[]>()
  for (const it of items) {
    const date = it.publish_at.slice(0, 10)
    if (!groups.has(date)) groups.set(date, [])
    groups.get(date)!.push(it)
  }
  const orders: Record<string, number> = {}
  for (const list of groups.values()) {
    list.sort((a, b) => a.publish_at.localeCompare(b.publish_at))
    list.forEach((it, i) => {
      orders[it.id] = i
    })
  }
  return orders
}

// ---------------------------------------------------------------------------
// items 逐行校验与归一化（CLI 报告与 UI 增量导入共用同一套规则与文案）
// ---------------------------------------------------------------------------
export function validateItems(
  records: Record<string, unknown>[],
  opts: ValidateItemsOptions,
): ValidateItemsResult {
  const { isCsv, knownProducts, knownMembers, now, strict } = opts
  const valid: ContentItem[] = []
  const skipped: SkippedRow[] = []
  const hintNames = new Map<string, string>() // 未知 product_id → 登记名（占位名可被后续行的 product_name 升级）
  const memberHintByName = new Map<string, string>() // 未知负责人姓名 → 新成员 id
  const memberHints: Member[] = []
  let forcedNullCount = 0
  let emptyProductCount = 0
  const seenIds = new Set<string>()

  // 成员自动 id：M-1xxx 段，取现有目录 id 数字后缀 max+1（与目录现有 id 不冲突）
  let memberSeq = 1000
  for (const id of knownMembers.values()) {
    const m = id.match(/(\d+)$/)
    if (m) memberSeq = Math.max(memberSeq, Number(m[1]))
  }
  /** 负责人姓名 → 成员 id：空 → ''（未分配，不警告不计数）；目录命中 → 既有 id；未知 → 自动登记 */
  const resolveOwner = (raw: unknown): string => {
    const name = String(raw ?? '').trim()
    if (!name) return ''
    const hit = knownMembers.get(name)
    if (hit) return hit
    const hinted = memberHintByName.get(name)
    if (hinted) return hinted
    const id = `M-${String(++memberSeq).padStart(4, '0')}`
    memberHintByName.set(name, id)
    memberHints.push({ id, name })
    return id
  }

  for (const [idx, rec] of records.entries()) {
    const rowLabel = isCsv ? `CSV 第 ${idx + 2} 行` : `第 ${idx + 1} 条`
    const fail = (reason: string): void => {
      if (strict) throw { strictRow: true, row: rowLabel, reason } satisfies StrictRowSignal
      skipped.push({ row: rowLabel, reason })
    }

    // title：必填非空
    const title = String(rec.title ?? '').trim()
    if (!title) {
      fail('title 必填且非空')
      continue
    }

    // type：5 类枚举
    const type = String(rec.type ?? '').trim()
    if (!(TYPES as readonly string[]).includes(type)) {
      fail(`type 非法: "${type}"，合法值: ${TYPES.join(' / ')}`)
      continue
    }

    // publish_at：必填，归一化
    if (rec.publish_at === undefined || String(rec.publish_at).trim() === '') {
      fail('publish_at 必填')
      continue
    }
    const publish_at = normalizePublishAt(rec.publish_at)
    if (!publish_at) {
      fail(`publish_at 无法解析: "${rec.publish_at}"（接受 YYYY-MM-DDTHH:mm / YYYY-MM-DD HH:mm / YYYY/M/D H:mm）`)
      continue
    }

    // status：可空——缺省按 publish_at 推导（未来 → 待发布，否则 → 已发布）；
    // 显式给定则必须命中 3 态枚举，非法值跳行
    const statusRaw = String(rec.status ?? '').trim()
    let status: ContentStatus
    if (!statusRaw) {
      status = publish_at > now ? '待发布' : '已发布'
    } else if ((STATUSES as readonly string[]).includes(statusRaw)) {
      status = statusRaw as ContentStatus
    } else {
      fail(`status 非法: "${statusRaw}"，合法值: ${STATUSES.join(' / ')}`)
      continue
    }

    // id：缺失时按内容哈希确定性生成（保证 --merge 幂等：同文件重复导入不产生重复条目）；
    // 显式 id 直接使用；重复报错
    const productRaw = String(rec.product_id ?? '').trim()
    const id =
      rec.id === undefined || String(rec.id).trim() === ''
        ? autoId(title, type, publish_at, productRaw)
        : String(rec.id).trim()
    if (seenIds.has(id)) {
      fail(`id 重复: ${id}`)
      continue
    }

    // product_id：可空——缺失/空置 ''（未归属，UI 显示「不明」，报告汇总，不跳行）；
    // 有值但不在已知目录 → 记入 productHints 自动登记（product_name 非空用作名称，否则 id 占位；
    // 同 id 多行取第一个非空 product_name；调用方须把内嵌 products 的 id 放进 knownProducts，
    // 内嵌优先不重复收集）。登记后卡片直接显示产品名，不再降级「不明」
    const product_id = productRaw
    if (!product_id) {
      emptyProductCount++
    }

    // 指标：可空 / 非负数字；status ≠ 已发布 → 强制 null（v14 起按状态而非按时间；
    // 默认推导下与时间口径一致，显式标「已发布」可为未来卡片解锁指标）
    const roi = normalizeMetric(rec.roi, 'roi')
    if (roi.error) {
      fail(roi.error)
      continue
    }
    const prop = normalizeMetric(rec.propagation_4h, 'propagation_4h')
    if (prop.error) {
      fail(prop.error)
      continue
    }
    const eng = normalizeMetric(rec.engagement_4h, 'engagement_4h')
    if (eng.error) {
      fail(eng.error)
      continue
    }

    const metricsLocked = status !== '已发布'
    if (metricsLocked && (roi.value !== null || prop.value !== null || eng.value !== null)) {
      forcedNullCount++
    }

    seenIds.add(id)
    // 行校验全部通过后才收集自动登记（跳过行不贡献）：
    // 产品 hint（未知 id）+ 负责人解析（未知姓名登记为新成员）
    if (product_id && !knownProducts.has(product_id)) {
      const pn = String(rec.product_name ?? '').trim()
      const prevName = hintNames.get(product_id)
      if (prevName === undefined) hintNames.set(product_id, pn || product_id)
      else if (prevName === product_id && pn) hintNames.set(product_id, pn) // 占位名 → 第一个非空 product_name
    }
    const content_owner_id = resolveOwner(rec.content_owner)
    const delivery_owner_id = resolveOwner(rec.delivery_owner)
    valid.push({
      id,
      title,
      type: type as ContentItem['type'],
      publish_at,
      roi: metricsLocked ? null : roi.value,
      comment: String(rec.comment ?? ''),
      product_id,
      status,
      content_owner_id,
      delivery_owner_id,
      propagation_4h: metricsLocked ? null : prop.value,
      engagement_4h: metricsLocked ? null : eng.value,
    })
  }

  return {
    valid,
    skipped,
    productHints: [...hintNames].map(([id, name]) => ({ id, name })),
    memberHints,
    emptyProductCount,
    forcedNullCount,
  }
}

// ---------------------------------------------------------------------------
// 产品文件逐行校验（id 必填非空且文件内唯一；name 必填非空）
// ---------------------------------------------------------------------------
export function validateProducts(
  records: Record<string, unknown>[],
  opts: ValidateProductsOptions,
): ValidateProductsResult {
  const { isCsv, strict } = opts
  const valid: ProductInput[] = []
  const skipped: SkippedRow[] = []
  const seen = new Set<string>()

  for (const [idx, rec] of records.entries()) {
    const rowLabel = isCsv ? `CSV 第 ${idx + 2} 行` : `第 ${idx + 1} 条`
    const fail = (reason: string): void => {
      if (strict) throw { strictRow: true, row: rowLabel, reason } satisfies StrictRowSignal
      skipped.push({ row: rowLabel, reason })
    }

    const id = String(rec.id ?? '').trim()
    if (!id) {
      fail('产品 id 必填且非空')
      continue
    }
    if (seen.has(id)) {
      fail(`产品 id 重复: ${id}`)
      continue
    }
    const name = String(rec.name ?? '').trim()
    if (!name) {
      fail('产品名称必填且非空')
      continue
    }
    seen.add(id)
    valid.push({ id, name })
  }

  return { valid, skipped }
}
