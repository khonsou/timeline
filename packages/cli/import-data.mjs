#!/usr/bin/env node
/**
 * 拾光轴 · Timeline Board —— 真实数据批量导入 CLI（薄封装）
 *
 * 用法（本地种子模式，行为不变）：
 *   npm run import:data -- <文件.json|文件.csv> [--dry-run] [--merge] [--strict]
 *   npm run import:data -- --products <产品文件.json|产品文件.csv> [--dry-run] [--merge] [--strict]
 *
 * 用法（v19 远端模式：直接写入远端看板，走 change-set 协议）：
 *   npm run import:data -- <文件> --board <board_id> [--api http://localhost:8787]
 *        [--password <看板密码>] [--no-commit] [--dry-run] [--strict]
 *   密码也可由环境变量 TIMELINE_BOARD_PASSWORD 提供；--dry-run 完全本地、不发任何请求。
 *   流程：本地解析/校验照旧 → auth 换 token → 整板 GET 取 version → 组装 create operations
 *   （文件原始 id 作 client_ref，服务端分配卡片 id；负责人按姓名传送由服务端解析登记）→
 *   POST /change-sets → 默认紧接 commit（Idempotency-Key 按内容哈希，重复执行不重复建卡；
 *   另有内容签名去重：已在板上的同内容卡片跳过）；409 VERSION_CONFLICT 自动取新 version 重试一次。
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
 * 远端模式注意：协议 v1 没有产品写端点，产品目录差异仅打印提示，请在建板种子或页面
 * 「产品管理」中处理，卡片导入照常继续（未知 product_id 原样保留）。
 *
 * v14 成员目录同理：负责人按**姓名**填写（内容负责人/投放负责人列），已知姓名复用既有 id，
 * 未知姓名自动登记（memberHints，M-1xxx 段自动 id）并差分合并进写出的 members 累积全量
 * （mergeMembers 以姓名为键，同名复用既有 id，导入永不删成员——删成员走页面「成员管理」）。
 * 远端模式下负责人一律按**姓名**传送给服务端，由服务端对远端目录解析/登记（M-xxxx）。
 * 指标强制 null 规则 v14 起按**状态**：status ≠ 已发布 → 三指标恒 null；
 * status 缺省按 publish_at 推导（未来 → 待发布，否则已发布），显式「已发布」可解锁未来卡片指标。
 *
 * 解析/校验/哈希/orders/差分全部来自共享核心 @timeline/core（packages/core/lib/import-core.ts，
 * Node 24 strip-types 经 workspaces 软链直引；与应用内「卡片增量导入」同一套规则）。
 * v19 起内置产品/成员目录常量也由 @timeline/core 统一提供（不再内联副本）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  BUILTIN_MEMBERS,
  BUILTIN_PRODUCTS,
  computeOrders,
  isStrictRowSignal,
  mergeMembers,
  mergeProducts,
  readItemsInput,
  readProductsInput,
  sha1Hex,
  validateItems,
  validateProducts,
} from '@timeline/core/import-core'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
// 写出目标：web 包的 public（vite 伺服根；首页「从本机现有数据初始化」读取）
const OUT_FILE = path.join(REPO_ROOT, 'web', 'public', 'data', 'board.json')

// 内置产品目录 id 集合（常量本体来自 @timeline/core，三端同一来源）
const BUILTIN_PRODUCT_IDS = new Set(BUILTIN_PRODUCTS.map((p) => p.id))

const pad = (n) => String(n).padStart(2, '0')

function nowKey() {
  const n = new Date()
  return `${n.getFullYear()}-${pad(n.getMonth() + 1)}-${pad(n.getDate())}T${pad(n.getHours())}:${pad(n.getMinutes())}`
}

// ---------------------------------------------------------------------------
// 参数（--board/--api/--password 为带值参数；其余 -- 开头为布尔开关；位置参数为文件）
// ---------------------------------------------------------------------------
const args = process.argv.slice(2)
const VALUE_FLAGS = new Set(['--board', '--api', '--password'])
const flags = new Set()
const values = new Map()
let file
for (let i = 0; i < args.length; i++) {
  const a = args[i]
  if (VALUE_FLAGS.has(a)) {
    const v = args[i + 1]
    if (v === undefined || v.startsWith('--')) {
      console.error(`参数 ${a} 缺值`)
      process.exit(2)
    }
    values.set(a, v)
    i++
  } else if (a.startsWith('--')) {
    flags.add(a)
  } else if (file === undefined) {
    file = a
  } else {
    console.error(`多余的位置参数: ${a}`)
    process.exit(2)
  }
}
const DRY_RUN = flags.has('--dry-run')
const MERGE = flags.has('--merge')
const STRICT = flags.has('--strict')
const PRODUCTS_MODE = flags.has('--products') // 独立产品目录导入（不与 items 文件混用）
// v19 远端模式：--board 给出即启用（--api 缺省 http://localhost:8787）
const BOARD_ID = values.get('--board')
const API_BASE = (values.get('--api') ?? 'http://localhost:8787').replace(/\/+$/, '')
const REMOTE = BOARD_ID !== undefined
const NO_COMMIT = flags.has('--no-commit')
const PASSWORD = values.get('--password') ?? process.env.TIMELINE_BOARD_PASSWORD

const USAGE = [
  '用法: npm run import:data -- <文件.json|文件.csv> [--dry-run] [--merge] [--strict]',
  '      npm run import:data -- --products <产品文件.json|产品文件.csv> [--dry-run] [--merge] [--strict]',
  '      远端模式: npm run import:data -- <文件> --board <board_id> [--api http://localhost:8787]',
  '                [--password <看板密码>] [--no-commit] [--dry-run] [--strict]',
  '      （密码也可用环境变量 TIMELINE_BOARD_PASSWORD 提供）',
]

if (!file) {
  console.error(USAGE.join('\n'))
  process.exit(2)
}
if (REMOTE && !DRY_RUN && !PASSWORD) {
  console.error('✗ 远端模式需要看板密码：--password <密码> 或环境变量 TIMELINE_BOARD_PASSWORD')
  console.error(USAGE.join('\n'))
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

// 已有 board.json 的成员目录（差分合并基线；无 members 键时为空数组）
function prevBoardMembers() {
  try {
    const prev = JSON.parse(readFileSync(OUT_FILE, 'utf8'))
    return Array.isArray(prev?.members) ? prev.members : []
  } catch {
    return []
  }
}

// ---------------------------------------------------------------------------
// v19 远端模式辅助：HTTP 调用（网络错误/429 统一处理）、鉴权、产品目录差异提示
// ---------------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 远端调用：连接失败 → exit 2；429 按 retry_after 等待后重试一次（仍 429 则原样返回） */
async function apiCall(method, p, { token, body, headers } = {}) {
  for (let attempt = 0; ; attempt++) {
    let res
    try {
      res = await fetch(`${API_BASE}/api${p}`, {
        method,
        headers: {
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
    } catch (e) {
      console.error(`✗ 无法连接 ${API_BASE}（${e.cause?.code ?? e.message}）——请确认 server 已启动、--api 地址正确`)
      process.exit(2)
    }
    let json = null
    try {
      json = await res.json()
    } catch {
      // 204 / 空响应
    }
    if (res.status === 429 && attempt === 0) {
      const wait = Number(json?.retry_after ?? 1)
      console.error(`  … 限速 429，按 retry_after 等待 ${wait} 秒后重试一次`)
      await sleep(wait * 1000)
      continue
    }
    return { status: res.status, body: json }
  }
}

/** 密码换 token：404 看板不存在 / 403 密码错误 / 429 锁定，均中文提示 exit 2 */
async function remoteAuth() {
  const r = await apiCall('POST', `/boards/${BOARD_ID}/auth`, { body: { password: PASSWORD } })
  if (r.status === 404) {
    console.error(`✗ 看板不存在: ${BOARD_ID}`)
    process.exit(2)
  }
  if (r.status === 403) {
    console.error('✗ 密码错误（403）')
    process.exit(2)
  }
  if (r.status !== 200 || !r.body?.token) {
    console.error(`✗ 鉴权失败（HTTP ${r.status}）: ${r.body?.error ?? ''}`)
    process.exit(2)
  }
  return r.body.token
}

function check401(r) {
  if (r.status === 401) {
    console.error('✗ token 缺失或已过期（401）')
    process.exit(2)
  }
}

/** 产品目录差异提示：协议 v1 没有产品写端点——只比对打印，不写远端（不静默失败、不伪造端点） */
async function remoteProductsNotice(token, incoming) {
  if (!incoming.length) return
  const r = await apiCall('GET', `/boards/${BOARD_ID}/products`, { token })
  check401(r)
  if (r.status !== 200) {
    console.error(`✗ 读取产品目录失败（HTTP ${r.status}）`)
    process.exit(2)
  }
  const diff = mergeProducts(r.body?.products ?? [], incoming)
  if (diff.added > 0 || diff.updated > 0) {
    console.log(`⚠ 产品目录差异：相对远端新增 ${diff.added} / 变更 ${diff.updated}`)
    console.log('  协议 v1 没有产品写端点——产品目录差异请在建板种子或页面「产品管理」中处理；')
    console.log('  卡片导入照常继续（未知 product_id 原样保留，不动产品目录）')
  } else {
    console.log('产品目录：远端已是最新（无差异）')
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

  // v19 远端模式：协议 v1 无产品写端点——只做差分比对与提示，不写远端、不写本地种子
  if (REMOTE) {
    if (DRY_RUN) {
      console.log('\n[dry-run] 远端模式完全本地：未发送任何请求')
    } else {
      const token = await remoteAuth()
      await remoteProductsNotice(token, validProducts)
    }
    process.exit(skippedProducts.length > 0 ? 1 : 0)
  }

  if (DRY_RUN) {
    console.log(`\n[dry-run] 未写出文件（目标: ${path.relative(REPO_ROOT, OUT_FILE)}）`)
  } else {
    mkdirSync(path.dirname(OUT_FILE), { recursive: true })
    writeFileSync(
      OUT_FILE,
      JSON.stringify({ products: finalProducts, importedAt: new Date().toISOString() }, null, 2) + '\n',
      'utf8',
    )
    console.log(`\n✓ 已写出: ${path.relative(REPO_ROOT, OUT_FILE)}（${finalProducts.length} 个产品）`)
    console.log('  仅接管产品目录、不影响现有内容卡片；下次打开/刷新页面时自动生效')
  }

  // exit code 语义同 items 版：strict 已在上面处理；默认有跳过 → 1，全有效 → 0
  process.exit(skippedProducts.length > 0 ? 1 : 0)
}

// ---------------------------------------------------------------------------
// v19 远端模式（items）：change-set 协议写入远端看板（本函数内部决定 exit code）
// ---------------------------------------------------------------------------
async function runRemoteItems() {
  // 本地校验报告（与种子模式同一来源数据）
  console.log('\n📥 导入报告（远端模式）')
  console.log(`源文件: ${path.resolve(file)}`)
  console.log(`目标: ${API_BASE} / 看板 ${BOARD_ID}`)
  console.log(
    `模式: ${DRY_RUN ? 'dry-run（完全本地，不发请求）' : NO_COMMIT ? '创建 pending change-set（不提交，待人工 review）' : '创建并提交 change-set'}`,
  )
  console.log(`总条数: ${input.records.length} | 有效: ${valid.length} | 跳过: ${skipped.length}`)
  for (const s of skipped) console.log(`  ✗ ${s.row}: ${s.reason}`)
  if (forcedNullCount > 0) console.log(`未发布卡指标强制置 null: ${forcedNullCount} 条`)
  if (emptyProductCount > 0) console.log(`未填写归属产品: ${emptyProductCount} 条（置空，UI 显示「不明」）`)

  if (DRY_RUN) {
    console.log('\n[dry-run] 远端模式完全本地：未发送任何请求')
    console.log(`[dry-run] 将生成 ${valid.length} 条 create operations（未与远端去重比对）`)
    process.exit(skipped.length > 0 ? 1 : 0)
  }

  const token = await remoteAuth()

  // 产品目录差异提示（协议 v1 无产品写端点；productHints 未知 id + 内嵌 products）
  const incomingProducts = mergeProducts(productHints, input.products ?? []).merged
  await remoteProductsNotice(token, incomingProducts)

  // 整板 GET：取 version（作 base_version）与已有卡片（内容签名幂等去重）
  const board = await apiCall('GET', `/boards/${BOARD_ID}`, { token })
  check401(board)
  if (board.status !== 200) {
    console.error(`✗ 读取看板失败（HTTP ${board.status}）`)
    process.exit(2)
  }
  const version = board.body.version
  const remoteItems = Array.isArray(board.body?.doc?.items) ? board.body.doc.items : []

  // 幂等去重：内容签名（title|type|publish_at|product_id）已在板上的卡片不再建
  const sig = (it) => `${it.title}|${it.type}|${it.publish_at}|${it.product_id}`
  const existing = new Set(remoteItems.map(sig))
  const fresh = valid.filter((it) => !existing.has(sig(it)))
  const dupCount = valid.length - fresh.length
  if (dupCount > 0) console.log(`已存在（内容相同，幂等跳过）: ${dupCount} 条`)
  if (fresh.length === 0) {
    console.log('\n✓ 无新增卡片（全部已存在），未创建 change-set')
    process.exit(skipped.length > 0 ? 1 : 0)
  }

  // 负责人按**姓名**传送（服务端对远端目录解析/未知姓名登记）；本地解析出的 id 反查姓名
  const idToName = new Map([...BUILTIN_MEMBERS, ...prevBoardMembers(), ...memberHints].map((m) => [m.id, m.name]))
  const ownerName = (idv) => (idv ? (idToName.get(idv) ?? idv) : undefined)

  const operations = fresh.map((it) => ({
    op: 'create',
    client_ref: it.id, // 文件里的原始 id（显式或内容哈希），仅用于追踪提交结果；卡片 id 由服务端分配
    item: {
      title: it.title,
      type: it.type,
      publish_at: it.publish_at,
      status: it.status,
      ...(it.product_id ? { product_id: it.product_id } : {}),
      ...(it.comment ? { comment: it.comment } : {}),
      ...(it.roi !== null ? { roi: it.roi } : {}),
      ...(it.propagation_4h !== null ? { propagation_4h: it.propagation_4h } : {}),
      ...(it.engagement_4h !== null ? { engagement_4h: it.engagement_4h } : {}),
      ...(it.links?.length ? { links: it.links } : {}),
      ...(ownerName(it.content_owner_id) ? { content_owner_id: ownerName(it.content_owner_id) } : {}),
      ...(ownerName(it.delivery_owner_id) ? { delivery_owner_id: ownerName(it.delivery_owner_id) } : {}),
    },
  }))

  // 幂等键按内容哈希：同一文件重复执行得到同一键（配合内容签名去重，双保险不重复建卡）
  const idemKey = `timeline-import-${BOARD_ID}-${sha1Hex(JSON.stringify(operations)).slice(0, 16)}`
  const source = { type: 'cli', external_run_id: `timeline-import-${new Date().toISOString()}` }
  const actor = { type: 'cli', id: 'timeline-import' }

  let baseVersion = version
  for (let attempt = 0; ; attempt++) {
    const cs = await apiCall('POST', `/boards/${BOARD_ID}/change-sets`, {
      token,
      body: { base_version: baseVersion, source, actor, operations },
    })
    check401(cs)
    if (cs.status === 400) {
      console.error(`✗ change-set 预校验失败: ${cs.body?.error}`)
      process.exit(2)
    }
    if (cs.status !== 201) {
      console.error(`✗ 创建 change-set 失败（HTTP ${cs.status}）: ${cs.body?.error ?? ''}`)
      process.exit(2)
    }
    const csid = cs.body.change_set_id

    if (NO_COMMIT) {
      console.log(`\n✓ change-set 已创建（pending，未提交）: ${csid}`)
      console.log(`  包含 ${operations.length} 条 create operations；人工 review 后可提交：`)
      console.log(`  查询: curl -s -H "Authorization: Bearer <token>" ${API_BASE}/api/boards/${BOARD_ID}/change-sets/${csid}`)
      console.log(
        `  提交: curl -X POST -H "Authorization: Bearer <token>" -H "Idempotency-Key: ${idemKey}" ${API_BASE}/api/boards/${BOARD_ID}/change-sets/${csid}/commit`,
      )
      process.exit(skipped.length > 0 ? 1 : 0)
    }

    const commit = await apiCall('POST', `/boards/${BOARD_ID}/change-sets/${csid}/commit`, {
      token,
      body: {},
      headers: { 'idempotency-key': idemKey },
    })
    check401(commit)
    if (commit.status === 200) {
      console.log(`\n✓ change-set 已提交: ${csid} → committed（看板 version ${baseVersion} → ${commit.body.version}）`)
      console.log(`新建卡片（${commit.body.items.length}）:`)
      const byRef = new Map(fresh.map((it) => [it.id, it]))
      for (const m of commit.body.items) {
        console.log(`  ${m.client_ref} → ${m.id}  ${byRef.get(m.client_ref)?.title ?? ''}`)
      }
      process.exit(skipped.length > 0 ? 1 : 0)
    }
    // 409 VERSION_CONFLICT：重新 GET 最新 version 重建 change-set 重试一次，仍冲突则失败退出
    if (commit.status === 409 && commit.body?.error === 'VERSION_CONFLICT' && attempt === 0) {
      console.error(`  … version 冲突（当前 ${commit.body.current_version}），重新取 version 重建 change-set 重试一次`)
      const again = await apiCall('GET', `/boards/${BOARD_ID}`, { token })
      check401(again)
      if (again.status !== 200) {
        console.error(`✗ 重新读取看板失败（HTTP ${again.status}）`)
        process.exit(2)
      }
      baseVersion = again.body.version
      continue
    }
    if (commit.status === 400) {
      console.error(`✗ commit 被 core 校验拒绝（看板零变化，change-set ${csid} 已置 rejected）:`)
      for (const e of commit.body?.errors ?? [commit.body?.error]) console.error(`  ✗ ${e}`)
      process.exit(2)
    }
    console.error(`✗ commit 失败（HTTP ${commit.status}）: ${commit.body?.error ?? ''}`)
    process.exit(2)
  }
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
  ...BUILTIN_PRODUCT_IDS,
  ...prevBoardProducts().map((p) => String(p.id)),
  ...(input.products ?? []).map((p) => p.id),
])
// 负责人按姓名解析：内置成员 + 已有 board.json 成员目录为已知姓名（同名复用既有 id）
const knownMembers = new Map(
  [...BUILTIN_MEMBERS, ...prevBoardMembers()].map((m) => [String(m.name), String(m.id)]),
)
const NOW = nowKey()

let valid, skipped, productHints, memberHints, emptyProductCount, forcedNullCount
try {
  ;({ valid, skipped, productHints, memberHints, emptyProductCount, forcedNullCount } = validateItems(input.records, {
    isCsv,
    knownProducts,
    knownMembers,
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

// v19 远端模式：本地校验完成后改走 change-set 协议写远端（种子文件逻辑完全不执行）
if (REMOTE) {
  await runRemoteItems()
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

// v16：单板容量硬上限——合并后总数超过 2000 整体拒绝（不搞半截导入）
if (finalItems.length > 2000) {
  console.error(`✗ 合并后共 ${finalItems.length} 条，超过单板上限 2000 张——已整体拒绝导入`)
  console.error('  请按时间切片拆分文件分批导入（每块看板一个时间段），或减少数据量后重试')
  process.exit(1)
}

const orders = computeOrders(finalItems)

// 产品目录（v13 差分累积写出）：productHints（未知 id 自动登记，product_name 缺省 id 占位）
// 先行、内嵌 products 的 name 优先（结合序与分步合并等价），再与已有 board.json 目录差分——
// board.json 是全新浏览器的唯一状态来源，必须累积全量目录（v12「结转」语义的自然延伸）；
// 应用端接管同样差分合并，未提及的一律保留。导入只能加/改产品，删除走页面「产品管理」。
const incomingProducts = mergeProducts(productHints, input.products ?? [])
const pdiff = mergeProducts(prevBoardProducts(), incomingProducts.merged)
const finalProducts = pdiff.merged.length > 0 ? pdiff.merged : undefined

// 成员目录（v14，与产品目录同哲学）：未知负责人姓名按 memberHints 自动登记，
// 与已有 board.json 成员目录按**姓名**差分合并（同名复用既有 id）后累积全量写出；
// 导入只能加成员，删除走页面「成员管理」。
const mdiff = mergeMembers(prevBoardMembers(), memberHints)
const finalMembers = mdiff.merged.length > 0 ? mdiff.merged : undefined

// ---------------------------------------------------------------------------
// 报告
// ---------------------------------------------------------------------------
console.log('\n📥 导入报告')
console.log(`源文件: ${path.resolve(file)}`)
console.log(`模式: ${DRY_RUN ? 'dry-run（不写文件）' : MERGE ? 'merge（合并进已有 board.json）' : '全量替换'}`)
console.log(`总条数: ${input.records.length} | 有效: ${valid.length} | 跳过: ${skipped.length}`)
for (const s of skipped) console.log(`  ✗ ${s.row}: ${s.reason}`)
const unpublishedCount = valid.filter((it) => it.status !== '已发布').length
console.log(`未发布（status ≠ 已发布，指标已强制置 null）: ${unpublishedCount} 条`)
if (forcedNullCount > 0) console.log(`  其中 ${forcedNullCount} 条原本带了指标值，已按未发布语义置 null`)
if (emptyProductCount > 0)
  console.log(`未填写归属产品: ${emptyProductCount} 条（已置空，UI 显示「不明」）`)
if (productHints.length > 0) {
  console.log(`自动登记新产品 (${productHints.length}):`)
  for (const h of productHints)
    console.log(`  ✚ ${h.id}  ${h.name}${h.name === h.id ? '（缺省名占位，可在「产品管理」改名）' : ''}`)
}
if (memberHints.length > 0) {
  console.log(`自动登记新成员 (${memberHints.length}):`)
  for (const h of memberHints) console.log(`  ✚ ${h.id}  ${h.name}`)
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
if (finalMembers)
  console.log(`成员目录差分：新增 ${mdiff.added} / 同名复用 ${mdiff.unchanged}（共 ${finalMembers.length} 个）`)

if (DRY_RUN) {
  console.log(`\n[dry-run] 未写出文件（目标: ${path.relative(REPO_ROOT, OUT_FILE)}）`)
} else {
  mkdirSync(path.dirname(OUT_FILE), { recursive: true })
  const out = {
    items: finalItems,
    orders,
    ...(finalProducts ? { products: finalProducts } : {}),
    ...(finalMembers ? { members: finalMembers } : {}),
    importedAt: new Date().toISOString(),
  }
  writeFileSync(OUT_FILE, JSON.stringify(out, null, 2) + '\n', 'utf8')
  console.log(`\n✓ 已写出: ${path.relative(REPO_ROOT, OUT_FILE)}（${finalItems.length} 条）`)
  console.log('  下次打开/刷新页面时自动生效（importedAt 变化才会接管 localStorage）')
}

// exit code：strict 已在上面处理；默认有跳过 → 1，全有效 → 0
process.exit(skipped.length > 0 ? 1 : 0)
