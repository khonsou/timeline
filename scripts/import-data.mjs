#!/usr/bin/env node
/**
 * 拾光轴 · Timeline Board —— 真实数据批量导入 CLI
 *
 * 用法：npm run import:data -- <文件.json|文件.csv> [--dry-run] [--merge] [--strict]
 *
 * 读取 JSON/CSV → 逐行校验并归一化为 ContentItem → 计算 orders →
 * 写出 public/data/board.json（{ items, orders, products?, importedAt }）。
 * 无第三方依赖。详细字段口径见 src/types/content.ts 与 README.md。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT_FILE = path.join(ROOT, 'public', 'data', 'board.json')

const TYPES = ['图文', '视频', '音频', '直播', '数据']
// 内置产品目录（与 src/lib/content-data.ts 的 PRODUCTS 保持一致）
const BUILTIN_PRODUCTS = new Set(['P-1001', 'P-1002', 'P-1003', 'P-1004', 'P-1005', 'P-1006'])

// 中文表头/字段别名 → ContentItem 英文字段
const ALIAS = {
  标题: 'title',
  类型: 'type',
  计划发布时间: 'publish_at',
  备注: 'comment',
  产品ID: 'product_id',
  ROI: 'roi',
  曝光4h: 'propagation_4h',
  互动4h: 'engagement_4h',
}
const FIELD_KEYS = [
  'id', 'title', 'type', 'publish_at', 'roi', 'comment',
  'product_id', 'propagation_4h', 'engagement_4h',
]

// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------
const args = process.argv.slice(2)
const flags = new Set(args.filter((a) => a.startsWith('--')))
const file = args.find((a) => !a.startsWith('--'))
const DRY_RUN = flags.has('--dry-run')
const MERGE = flags.has('--merge')
const STRICT = flags.has('--strict')

if (!file) {
  console.error('用法: npm run import:data -- <文件.json|文件.csv> [--dry-run] [--merge] [--strict]')
  process.exit(2)
}
if (!existsSync(file)) {
  console.error(`文件不存在: ${file}`)
  process.exit(2)
}

// ---------------------------------------------------------------------------
// 解析输入
// ---------------------------------------------------------------------------
function parseCsv(text) {
  // RFC4180 迷你解析器：引号包裹、双引号转义、字段内逗号/换行
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1) // BOM
  const rows = []
  let row = []
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

function normalizeKeys(rec) {
  const out = {}
  for (const [k, v] of Object.entries(rec)) {
    const key = ALIAS[k.trim()] ?? k.trim()
    if (FIELD_KEYS.includes(key)) out[key] = v
  }
  return out
}

function readInput(filePath) {
  const ext = path.extname(filePath).toLowerCase()
  const text = readFileSync(filePath, 'utf8')
  if (ext === '.json') {
    const data = JSON.parse(text)
    if (Array.isArray(data)) return { records: data.map(normalizeKeys), products: undefined }
    if (data && Array.isArray(data.items)) {
      // { items: [...], products?: [...] } 包裹形式
      let products
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
      const rec = {}
      header.forEach((h, i) => {
        if (h) rec[h] = r[i] ?? ''
      })
      return normalizeKeys(rec)
    })
    return { records, products: undefined }
  }
  throw new Error(`不支持的文件类型: ${ext}（仅 .json / .csv）`)
}

// ---------------------------------------------------------------------------
// 字段校验与归一化
// ---------------------------------------------------------------------------
const pad = (n) => String(n).padStart(2, '0')

/** 接受 YYYY-MM-DDTHH:mm / YYYY-MM-DD HH:mm / YYYY/M/D H:mm（可带秒），归一化为 YYYY-MM-DDTHH:mm */
function normalizePublishAt(raw) {
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
function normalizeMetric(raw, name) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return { value: null }
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) return { error: `${name} 须为空或非负数字，得到 "${raw}"` }
  return { value: n }
}

function nowKey() {
  const n = new Date()
  return `${n.getFullYear()}-${pad(n.getMonth() + 1)}-${pad(n.getDate())}T${pad(n.getHours())}:${pad(n.getMinutes())}`
}

// ---------------------------------------------------------------------------
// orders 计算：按日期分组，组内按 publish_at 时分排序赋 0,1,2…
// ---------------------------------------------------------------------------
function computeOrders(items) {
  const groups = new Map()
  for (const it of items) {
    const date = it.publish_at.slice(0, 10)
    if (!groups.has(date)) groups.set(date, [])
    groups.get(date).push(it)
  }
  const orders = {}
  for (const list of groups.values()) {
    list.sort((a, b) => a.publish_at.localeCompare(b.publish_at))
    list.forEach((it, i) => {
      orders[it.id] = i
    })
  }
  return orders
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
let input
try {
  input = readInput(file)
} catch (e) {
  console.error(`解析失败: ${e.message}`)
  process.exit(2)
}

const isCsv = path.extname(file).toLowerCase() === '.csv'
const knownProducts = new Set([...BUILTIN_PRODUCTS, ...(input.products ?? []).map((p) => p.id)])
const NOW = nowKey()

const valid = []
const skipped = [] // { row, reason }
const warnings = [] // 未知 product_id
let forcedNullCount = 0
const seenIds = new Set()

for (const [idx, rec] of input.records.entries()) {
  const rowLabel = isCsv ? `CSV 第 ${idx + 2} 行` : `第 ${idx + 1} 条`
  const fail = (reason) => {
    if (STRICT) {
      console.error(`✗ ${rowLabel}: ${reason}\n--strict 模式，遇第一个无效行退出`)
      process.exit(1)
    }
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
  if (!TYPES.includes(type)) {
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

  // id：缺失时按内容哈希确定性生成（保证 --merge 幂等：同文件重复导入不产生重复条目）；
  // 显式 id 直接使用；重复报错
  const id =
    rec.id === undefined || String(rec.id).trim() === ''
      ? `auto-${createHash('sha1').update(`${title}|${type}|${publish_at}|${String(rec.product_id ?? '').trim()}`).digest('hex').slice(0, 16)}`
      : String(rec.id).trim()
  if (seenIds.has(id)) {
    fail(`id 重复: ${id}`)
    continue
  }

  // product_id：必填；不在目录 → 警告但保留
  const product_id = String(rec.product_id ?? '').trim()
  if (!product_id) {
    fail('product_id 必填且非空')
    continue
  }
  if (!knownProducts.has(product_id)) {
    warnings.push(`${rowLabel}: 未知 product_id "${product_id}"（已保留，UI 降级显示 id）`)
  }

  // 指标：可空 / 非负数字；未发布强制 null
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

  const unpublished = publish_at > NOW
  if (unpublished && (roi.value !== null || prop.value !== null || eng.value !== null)) {
    forcedNullCount++
  }

  seenIds.add(id)
  valid.push({
    id,
    title,
    type,
    publish_at,
    roi: unpublished ? null : roi.value,
    comment: String(rec.comment ?? ''),
    product_id,
    propagation_4h: unpublished ? null : prop.value,
    engagement_4h: unpublished ? null : eng.value,
  })
}

// ---------------------------------------------------------------------------
// 合并 / 全量
// ---------------------------------------------------------------------------
let finalItems = valid
let finalProducts = input.products
if (MERGE && existsSync(OUT_FILE) && !DRY_RUN) {
  try {
    const prev = JSON.parse(readFileSync(OUT_FILE, 'utf8'))
    if (Array.isArray(prev?.items)) {
      const map = new Map(prev.items.map((it) => [it.id, it]))
      for (const it of valid) map.set(it.id, it) // 同 id 覆盖、新 id 追加
      finalItems = [...map.values()]
      if (!finalProducts && Array.isArray(prev.products)) finalProducts = prev.products
    }
  } catch {
    console.warn('⚠ 已有 board.json 解析失败，--merge 退化为全量替换')
  }
} else if (MERGE && DRY_RUN && existsSync(OUT_FILE)) {
  try {
    const prev = JSON.parse(readFileSync(OUT_FILE, 'utf8'))
    if (Array.isArray(prev?.items)) {
      const map = new Map(prev.items.map((it) => [it.id, it]))
      for (const it of valid) map.set(it.id, it)
      finalItems = [...map.values()]
      if (!finalProducts && Array.isArray(prev.products)) finalProducts = prev.products
    }
  } catch {}
}

const orders = computeOrders(finalItems)

// ---------------------------------------------------------------------------
// 报告
// ---------------------------------------------------------------------------
console.log('\n📥 导入报告')
console.log(`源文件: ${path.resolve(file)}`)
console.log(`模式: ${DRY_RUN ? 'dry-run（不写文件）' : MERGE ? 'merge（合并进已有 board.json）' : '全量替换'}`)
console.log(`总条数: ${input.records.length} | 有效: ${valid.length} | 跳过: ${skipped.length}`)
for (const s of skipped) console.log(`  ✗ ${s.row}: ${s.reason}`)
const unpublishedCount = valid.filter((it) => it.publish_at > NOW).length
console.log(`未发布（publish_at 晚于当前时间，指标已强制置 null）: ${unpublishedCount} 条`)
if (forcedNullCount > 0) console.log(`  其中 ${forcedNullCount} 条原本带了指标值，已按未发布语义置 null`)
if (warnings.length > 0) {
  console.log(`未知 product_id 警告 (${warnings.length}):`)
  for (const w of warnings) console.log(`  ⚠ ${w}`)
}
const dist = new Map()
for (const it of finalItems) {
  const d = it.publish_at.slice(0, 10)
  dist.set(d, (dist.get(d) ?? 0) + 1)
}
console.log(`日期分布（${dist.size} 天）:`)
for (const [d, n] of [...dist.entries()].sort()) console.log(`  ${d}  ${'█'.repeat(n)} ${n}`)
console.log(`orders: 已按日期分组、组内按时分排序重算（共 ${Object.keys(orders).length} 条）`)

if (DRY_RUN) {
  console.log(`\n[dry-run] 未写出文件（目标: ${path.relative(ROOT, OUT_FILE)}）`)
} else {
  mkdirSync(path.dirname(OUT_FILE), { recursive: true })
  const out = {
    items: finalItems,
    orders,
    ...(finalProducts ? { products: finalProducts } : {}),
    importedAt: new Date().toISOString(),
  }
  writeFileSync(OUT_FILE, JSON.stringify(out, null, 2) + '\n', 'utf8')
  console.log(`\n✓ 已写出: ${path.relative(ROOT, OUT_FILE)}（${finalItems.length} 条）`)
  console.log('  下次打开/刷新页面时自动生效（importedAt 变化才会接管 localStorage）')
}

// exit code：strict 已在上面处理；默认有跳过 → 1，全有效 → 0
process.exit(skipped.length > 0 ? 1 : 0)
