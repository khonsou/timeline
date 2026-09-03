#!/usr/bin/env node
/**
 * 拾光轴 · Timeline Board —— 真实数据批量导入 CLI（薄封装）
 *
 * 用法：npm run import:data -- <文件.json|文件.csv> [--dry-run] [--merge] [--strict]
 *       npm run import:data -- --products <产品文件.json|产品文件.csv> [--dry-run] [--merge] [--strict]
 *
 * items 模式：读取 JSON/CSV → 逐行校验并归一化为 ContentItem → 计算 orders →
 * 写出 public/data/board.json（{ items, orders, products?, importedAt }）。
 * products 独立模式：仅导入产品目录 → 写出 { products, importedAt }（无 items 键，
 * 应用端只接管产品目录，不动现有内容卡片）。无第三方依赖。
 *
 * v13 产品目录差分语义：写出的 products = 与已有 board.json 差分合并后的累积全量
 * （board.json 是全新浏览器的唯一状态来源）；应用端接管一律 mergeProducts 差分合并进
 * 本地目录（同 id 改名更新、新 id 追加、未提及保留，永不删除——删产品走页面「产品管理」；
 * name===id 的占位名不覆盖既有名称）。items 中未知 product_id 按 productHints 自动登记
 * （可选 product_name 作名，缺省 id 占位）并合并进写出的 products，应用加载逻辑保持简单。
 *
 * 解析/校验/哈希/orders/差分全部来自共享核心 src/lib/import-core.ts
 * （Node 24 原生 strip-types 直接引用；与应用内「卡片增量导入」同一套规则）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  computeOrders,
  isStrictRowSignal,
  mergeProducts,
  readItemsInput,
  readProductsInput,
  validateItems,
  validateProducts,
} from '../src/lib/import-core.ts'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT_FILE = path.join(ROOT, 'public', 'data', 'board.json')

// 内置产品目录（与 src/lib/content-data.ts 的 PRODUCTS 保持一致：仅看板自身 P-1000）
const BUILTIN_PRODUCTS = new Set(['P-1000'])

const pad = (n) => String(n).padStart(2, '0')

function nowKey() {
  const n = new Date()
  return `${n.getFullYear()}-${pad(n.getMonth() + 1)}-${pad(n.getDate())}T${pad(n.getHours())}:${pad(n.getMinutes())}`
}

// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------
const args = process.argv.slice(2)
const flags = new Set(args.filter((a) => a.startsWith('--')))
const file = args.find((a) => !a.startsWith('--'))
const DRY_RUN = flags.has('--dry-run')
const MERGE = flags.has('--merge')
const STRICT = flags.has('--strict')
const PRODUCTS_MODE = flags.has('--products') // 独立产品目录导入（不与 items 文件混用）

if (!file) {
  console.error('用法: npm run import:data -- <文件.json|文件.csv> [--dry-run] [--merge] [--strict]')
  console.error('      npm run import:data -- --products <产品文件.json|产品文件.csv> [--dry-run] [--merge] [--strict]')
  process.exit(2)
}
if (!existsSync(file)) {
  console.error(`文件不存在: ${file}`)
  process.exit(2)
}

const ext = path.extname(file).toLowerCase()
const text = readFileSync(file, 'utf8')
const isCsv = ext === '.csv'

// 已有 board.json 的产品目录纳入已知集合（两步导入「先产品后卡片」时不再误报未知 id）
function prevBoardProducts() {
  try {
    const prev = JSON.parse(readFileSync(OUT_FILE, 'utf8'))
    return Array.isArray(prev?.products) ? prev.products : []
  } catch {
    return []
  }
}

// ---------------------------------------------------------------------------
// products 独立模式：仅产品目录导入
// 写出 { products, importedAt }（无 items 键）——应用端仅接管产品目录，不动 items/orders
// ---------------------------------------------------------------------------
if (PRODUCTS_MODE) {
  let rawProducts
  try {
    rawProducts = readProductsInput(text, ext)
  } catch (e) {
    console.error(`解析失败: ${e.message}`)
    process.exit(2)
  }

  let validProducts, skippedProducts
  try {
    ;({ valid: validProducts, skipped: skippedProducts } = validateProducts(rawProducts, {
      isCsv,
      strict: STRICT,
    }))
  } catch (e) {
    if (isStrictRowSignal(e)) {
      console.error(`✗ ${e.row}: ${e.reason}\n--strict 模式，遇第一个无效行退出`)
      process.exit(1)
    }
    throw e
  }

  // v13 差分合并：目录只增/改、永不删除（删除走页面「产品管理」）。
  // 与已有 board.json 的 products 按 id 差分合并后写出——board.json 是全新浏览器的唯一
  // 状态来源，必须累积全量目录；应用端接管同样差分合并，未提及的一律保留。
  // --merge 为兼容保留（v13 起语义已恒为差分）
  const pdiff = mergeProducts(prevBoardProducts(), validProducts)
  const finalProducts = pdiff.merged

  console.log('\n📥 产品目录导入报告')
  console.log(`源文件: ${path.resolve(file)}`)
  console.log(
    `模式: ${DRY_RUN ? 'dry-run（不写文件）' : '差分合并产品目录（只增/改，不删除；删除请用页面「产品管理」）'}`,
  )
  console.log(`总条数: ${rawProducts.length} | 有效: ${validProducts.length} | 跳过: ${skippedProducts.length}`)
  for (const s of skippedProducts) console.log(`  ✗ ${s.row}: ${s.reason}`)
  console.log(`产品目录差分：新增 ${pdiff.added} / 更新 ${pdiff.updated} / 保留 ${pdiff.unchanged}（共 ${finalProducts.length} 个）`)
  console.log(`产品目录（${finalProducts.length} 个）:`)
  for (const p of finalProducts) console.log(`  ${p.id}  ${p.name}`)

  if (DRY_RUN) {
    console.log(`\n[dry-run] 未写出文件（目标: ${path.relative(ROOT, OUT_FILE)}）`)
  } else {
    mkdirSync(path.dirname(OUT_FILE), { recursive: true })
    writeFileSync(
      OUT_FILE,
      JSON.stringify({ products: finalProducts, importedAt: new Date().toISOString() }, null, 2) + '\n',
      'utf8',
    )
    console.log(`\n✓ 已写出: ${path.relative(ROOT, OUT_FILE)}（${finalProducts.length} 个产品）`)
    console.log('  仅接管产品目录、不影响现有内容卡片；下次打开/刷新页面时自动生效')
  }

  // exit code 语义同 items 版：strict 已在上面处理；默认有跳过 → 1，全有效 → 0
  process.exit(skippedProducts.length > 0 ? 1 : 0)
}

// ---------------------------------------------------------------------------
// 主流程（items 模式）
// ---------------------------------------------------------------------------
let input
try {
  input = readItemsInput(text, ext)
} catch (e) {
  console.error(`解析失败: ${e.message}`)
  process.exit(2)
}

const knownProducts = new Set([
  ...BUILTIN_PRODUCTS,
  ...prevBoardProducts().map((p) => String(p.id)),
  ...(input.products ?? []).map((p) => p.id),
])
const NOW = nowKey()

let valid, skipped, productHints, emptyProductCount, forcedNullCount
try {
  ;({ valid, skipped, productHints, emptyProductCount, forcedNullCount } = validateItems(input.records, {
    isCsv,
    knownProducts,
    now: NOW,
    strict: STRICT,
  }))
} catch (e) {
  if (isStrictRowSignal(e)) {
    console.error(`✗ ${e.row}: ${e.reason}\n--strict 模式，遇第一个无效行退出`)
    process.exit(1)
  }
  throw e
}

// ---------------------------------------------------------------------------
// 合并 / 全量（items）；产品目录统一走 v13 差分合并（见下方 pdiff）
// ---------------------------------------------------------------------------
let finalItems = valid
if (MERGE && existsSync(OUT_FILE) && !DRY_RUN) {
  try {
    const prev = JSON.parse(readFileSync(OUT_FILE, 'utf8'))
    if (Array.isArray(prev?.items)) {
      const map = new Map(prev.items.map((it) => [it.id, it]))
      for (const it of valid) map.set(it.id, it) // 同 id 覆盖、新 id 追加
      finalItems = [...map.values()]
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
    }
  } catch {}
}

const orders = computeOrders(finalItems)

// 产品目录（v13 差分累积写出）：productHints（未知 id 自动登记，product_name 缺省 id 占位）
// 先行、内嵌 products 的 name 优先（结合序与分步合并等价），再与已有 board.json 目录差分——
// board.json 是全新浏览器的唯一状态来源，必须累积全量目录（v12「结转」语义的自然延伸）；
// 应用端接管同样差分合并，未提及的一律保留。导入只能加/改产品，删除走页面「产品管理」。
const incomingProducts = mergeProducts(productHints, input.products ?? [])
const pdiff = mergeProducts(prevBoardProducts(), incomingProducts.merged)
const finalProducts = pdiff.merged.length > 0 ? pdiff.merged : undefined

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
if (emptyProductCount > 0)
  console.log(`未填写归属产品: ${emptyProductCount} 条（已置空，UI 显示「不明」）`)
if (productHints.length > 0) {
  console.log(`自动登记新产品 (${productHints.length}):`)
  for (const h of productHints)
    console.log(`  ✚ ${h.id}  ${h.name}${h.name === h.id ? '（缺省名占位，可在「产品管理」改名）' : ''}`)
}
const dist = new Map()
for (const it of finalItems) {
  const d = it.publish_at.slice(0, 10)
  dist.set(d, (dist.get(d) ?? 0) + 1)
}
console.log(`日期分布（${dist.size} 天）:`)
for (const [d, n] of [...dist.entries()].sort()) console.log(`  ${d}  ${'█'.repeat(n)} ${n}`)
console.log(`orders: 已按日期分组、组内按时分排序重算（共 ${Object.keys(orders).length} 条）`)
if (finalProducts)
  console.log(`产品目录差分：新增 ${pdiff.added} / 更新 ${pdiff.updated} / 保留 ${pdiff.unchanged}（共 ${finalProducts.length} 个）`)

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
