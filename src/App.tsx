import { useEffect, useMemo, useRef, useState } from 'react'
import TopBar from '@/components/TopBar'
import Board, { type BoardApi } from '@/components/board/Board'
import DetailDialog from '@/components/board/DetailDialog'
import ProductManagerDialog from '@/components/board/ProductManagerDialog'
import ImportResultDialog, { type ImportReport } from '@/components/board/ImportResultDialog'
import type { ContentItem, ContentType } from '@/types/content'
import {
  PRODUCTS,
  TYPE_KEYS,
  guideCards,
  pad2,
  setRuntimeProducts,
  todayStr,
  uid,
  type Product,
} from '@/lib/content-data'
import { nextOrder, publishDateOf, type Orders } from '@/lib/board-view'
import { computeOrders, mergeProducts, readItemsInput, validateItems } from '@/lib/import-core'

const STORAGE_KEY = 'timeline-board-v4'
const SEED_MARKER_KEY = 'timeline-board-v4:seedImportedAt'
const PRODUCTS_KEY = 'timeline-board-v4:products'
const LEGACY_SEED_PRODUCTS_KEY = 'timeline-board-v4:seedProducts' // v11 遗留 key，仅作迁移读取
const PUBLISH_AT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/

interface PersistedState {
  items: ContentItem[]
  orders: Orders
}

// 校验 { items, orders } 结构；合法返回修补后的数据，非法返回 null。
// items 允许为空数组——用户删光卡片是合法状态，刷新不得复活引导卡。
function validateState(parsed: unknown): PersistedState | null {
  const items = (parsed as PersistedState | null)?.items
  const orders = (parsed as PersistedState | null)?.orders
  if (
    Array.isArray(items) &&
    items.every(
      (c) =>
        c &&
        typeof c.id === 'string' &&
        typeof c.title === 'string' &&
        typeof c.publish_at === 'string' &&
        PUBLISH_AT_RE.test(c.publish_at) &&
        TYPE_KEYS.includes(c.type as ContentType) &&
        typeof c.product_id === 'string' &&
        typeof c.comment === 'string' &&
        (typeof c.roi === 'number' || c.roi === null) &&
        (typeof c.propagation_4h === 'number' || c.propagation_4h === null) &&
        (typeof c.engagement_4h === 'number' || c.engagement_4h === null),
    ) &&
    orders &&
    typeof orders === 'object' &&
    !Array.isArray(orders) &&
    Object.values(orders).every((v) => typeof v === 'number')
  ) {
    // 兜底：为缺失 order 的条目补齐到当日列末尾
    const patched: Orders = { ...(orders as Orders) }
    for (const item of items as ContentItem[]) {
      if (typeof patched[item.id] !== 'number') {
        patched[item.id] = nextOrder(items as ContentItem[], patched, publishDateOf(item))
      }
    }
    return { items: items as ContentItem[], orders: patched }
  }
  return null
}

// localStorage 加载语义：
//   key 不存在（首次启动）→ 播种两张引导卡；
//   key 存在且结构合法（含空 items）→ 照用；
//   key 存在但结构损坏 → 视同首次启动，重新播种引导卡。
function loadState(): PersistedState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const valid = validateState(JSON.parse(raw))
      if (valid) return valid
    }
  } catch {
    // 数据损坏时落到引导卡
  }
  return guideCards()
}

// ---------------------------------------------------------------------------
// 产品目录：一等本地状态。初始 = 内置目录（仅 P-1000 光轴）；
// 兼容读取 v11 遗留的 seedProducts key；空数组是合法状态（用户删光产品）
// ---------------------------------------------------------------------------
function loadProducts(): Product[] {
  const parse = (raw: string | null): Product[] | null => {
    if (!raw) return null
    try {
      const arr: unknown = JSON.parse(raw)
      if (Array.isArray(arr) && arr.every((p) => p && typeof p.id === 'string' && typeof p.name === 'string')) {
        return arr as Product[]
      }
    } catch {
      // 落到下一条候选
    }
    return null
  }
  return parse(localStorage.getItem(PRODUCTS_KEY)) ?? parse(localStorage.getItem(LEGACY_SEED_PRODUCTS_KEY)) ?? PRODUCTS
}

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六']

export default function App() {
  const [state, setState] = useState<PersistedState>(loadState)
  const { items, orders } = state
  // 产品目录一等状态：变更唯一入口 applyProducts（同步运行时解析 + 持久化 + React 态）
  const [products, setProducts] = useState<Product[]>(() => {
    const p = loadProducts()
    setRuntimeProducts(p) // 首帧渲染前同步，resolveProduct/listProducts 即刻可用
    return p
  })
  // 详情弹窗：detailCardId = 打开的卡片；detailAutoEdit = 新增后标题直接进入编辑
  const [detailCardId, setDetailCardId] = useState<string | null>(null)
  const [detailAutoEdit, setDetailAutoEdit] = useState(false)
  const [productsOpen, setProductsOpen] = useState(false) // 产品管理弹窗
  const [importReport, setImportReport] = useState<ImportReport | null>(null) // 导入结果弹窗
  const boardApiRef = useRef<BoardApi | null>(null)

  const applyProducts = (next: Product[]) => {
    setRuntimeProducts(next) // 先同步模块级解析，保证接下来的渲染读到新目录
    try {
      localStorage.setItem(PRODUCTS_KEY, JSON.stringify(next))
    } catch {
      // 存储不可用时仅内存生效
    }
    setProducts(next)
  }

  // 每次变更写入 localStorage
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
    } catch {
      // 存储不可用时静默降级为纯内存状态
    }
  }, [state])

  // ------------------------------------------------------------------
  // 启动加载顺序：board.json（importedAt 变化才接管）> localStorage > 引导卡
  // 同步部分已用 localStorage/引导卡渲染，这里异步检查 CLI 导入的 seed
  // ------------------------------------------------------------------
  useEffect(() => {
    let cancelled = false
    fetch('data/board.json')
      .then((r) => (r.ok ? r.json() : null))
      .then((seed: unknown) => {
        if (cancelled || !seed) return
        const importedAt = (seed as { importedAt?: unknown }).importedAt
        if (typeof importedAt !== 'string') return
        // importedAt 与 localStorage 标记相同 ⇒ 已接管过（用户编辑在 localStorage），不再接管
        if (localStorage.getItem(SEED_MARKER_KEY) === importedAt) return

        const seedProducts = (seed as { products?: unknown }).products
        const validProducts =
          Array.isArray(seedProducts) &&
          seedProducts.length > 0 &&
          seedProducts.every((p) => p && typeof p.id === 'string' && typeof p.name === 'string')
            ? (seedProducts as Product[])
            : null
        const valid = validateState(seed)
        const mark = () => {
          try {
            localStorage.setItem(SEED_MARKER_KEY, importedAt)
          } catch {
            // 存储不可用时仅内存生效
          }
        }

        if (valid) {
          // 全量接管：items + orders；携带 products 时**差分合并**进现有产品目录
          // （v13：导入只能加/改产品、永不删除，删产品走「产品管理」弹窗）
          if (validProducts) applyProducts(mergeProducts(products, validProducts).merged)
          mark()
          setState(valid)
          return
        }

        // 仅产品目录接管（board.json 无 items 键）：不动用户现有 items/orders，目录同样差分合并
        if (validProducts) {
          applyProducts(mergeProducts(products, validProducts).merged)
          mark()
        }
      })
      .catch(() => {
        // 404 / 解析失败：静默跳过
      })
    return () => {
      cancelled = true
    }
  }, [])

  // 当天日期动态显示
  const dateStr = useMemo(() => {
    const now = new Date()
    return `${now.getFullYear()} 年 ${now.getMonth() + 1} 月 ${now.getDate()} 日 · 星期${WEEKDAYS[now.getDay()]}`
  }, [])

  const coveredDays = useMemo(() => new Set(items.map((c) => publishDateOf(c))).size, [items])

  // Board 需要的细粒度 setter（视图层 orders 与数据层 items 分开更新）
  const setItems: React.Dispatch<React.SetStateAction<ContentItem[]>> = (updater) =>
    setState((prev) => ({
      ...prev,
      items: typeof updater === 'function' ? updater(prev.items) : updater,
    }))
  const setOrders: React.Dispatch<React.SetStateAction<Orders>> = (updater) =>
    setState((prev) => ({
      ...prev,
      orders: typeof updater === 'function' ? updater(prev.orders) : updater,
    }))

  const updateCard = (id: string, patch: Partial<ContentItem>) => {
    // publish_at 语义：日期部分变化 → 卡片移到目标日列末尾（orders 更新）；
    // 改到未来 → 三指标强制置 null（与 CLI 导入同口径的未发布语义）
    const newPublishAt = patch.publish_at
    if (typeof newPublishAt === 'string') {
      const item = items.find((c) => c.id === id)
      if (item) {
        const now = new Date()
        const nowKey = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}T${pad2(now.getHours())}:${pad2(now.getMinutes())}`
        if (newPublishAt > nowKey) {
          patch = { ...patch, roi: null, propagation_4h: null, engagement_4h: null }
        }
        const newDate = newPublishAt.slice(0, 10)
        if (newDate !== publishDateOf(item)) {
          const order = nextOrder(items, orders, newDate)
          setOrders((prev) => ({ ...prev, [id]: order }))
        }
      }
    }
    setItems((prev) => prev.map((c) => (c.id === id ? { ...c, ...patch } : c)))
  }

  const deleteCard = (id: string) => {
    // 删除详情中正在展示的卡片时关闭弹窗
    if (id === detailCardId) {
      setDetailCardId(null)
      setDetailAutoEdit(false)
    }
    setItems((prev) => prev.filter((c) => c.id !== id))
    setOrders((prev) => {
      const next = { ...prev }
      delete next[id]
      return next
    })
  }

  const openDetail = (id: string) => {
    setDetailAutoEdit(false)
    setDetailCardId(id)
  }
  const closeDetail = () => {
    setDetailCardId(null)
    setDetailAutoEdit(false)
  }

  // 新增空卡片：publish_at = 该列日期 + （今天列用当前 HH:mm，其他列 09:00），
  // 指标 null，order = 列内末尾；创建后直接打开详情弹窗且标题处于编辑态。
  // id / 随机字段在 updater 外生成：updater 必须保持纯函数（StrictMode 会双调用），
  // 且 setDetailCardId 不能在 setState 的 updater 里调用（副作用会导致状态丢失）
  const addCard = (date: string) => {
    const id = uid()
    const type = TYPE_KEYS[Math.floor(Math.random() * TYPE_KEYS.length)]
    const product_id = PRODUCTS[Math.floor(Math.random() * PRODUCTS.length)].id
    const now = new Date()
    const hhmm =
      date === todayStr() ? `${pad2(now.getHours())}:${pad2(now.getMinutes())}` : '09:00'
    const order = nextOrder(items, orders, date)
    const item: ContentItem = {
      id,
      title: '',
      type,
      publish_at: `${date}T${hhmm}`,
      roi: null,
      comment: '',
      product_id,
      propagation_4h: null,
      engagement_4h: null,
    }
    setItems((prev) => [...prev, item])
    setOrders((prev) => ({ ...prev, [id]: order }))
    setDetailAutoEdit(true)
    setDetailCardId(id)
  }

  const addToToday = () => addCard(todayStr())

  // ------------------------------------------------------------------
  // 顶栏「导入」：UI 版卡片增量导入（共享 import-core，merge 语义与 CLI --merge 一致）
  // 同 id 覆盖、新 id 追加、orders 全量重算；产品目录走差分合并：
  //   未知 product_id 按 productHints 自动登记（product_name 作名，缺省 id 占位），
  //   JSON 内嵌 products 的 name 优先于 hint 占位名；合并结果统一经 applyProducts 落盘；
  // 解析失败 / 全无效时不落任何数据，只弹错误报告
  // ------------------------------------------------------------------
  const handleImportFile = async (file: File) => {
    const filename = file.name
    const ext = filename.slice(filename.lastIndexOf('.')).toLowerCase()
    const text = await file.text()
    let input
    try {
      input = readItemsInput(text, ext)
    } catch (e) {
      setImportReport({
        filename,
        error: `文件解析失败：${e instanceof Error ? e.message : String(e)}`,
      })
      return
    }
    const now = new Date()
    const nowKey = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}T${pad2(now.getHours())}:${pad2(now.getMinutes())}`
    const r = validateItems(input.records, {
      isCsv: ext === '.csv',
      // 内嵌 products 的 id 视为已知：不重复收集 hint，内嵌 name 优先
      knownProducts: new Set([...products.map((p) => p.id), ...(input.products ?? []).map((p) => p.id)]),
      now: nowKey,
    })
    if (r.valid.length === 0) {
      setImportReport({
        filename,
        error: '没有可导入的有效行，未导入任何数据',
        total: input.records.length,
        skipped: r.skipped,
      })
      return
    }
    // merge 语义：同 id 覆盖、新 id 追加，orders 全量重算
    const map = new Map(items.map((it) => [it.id, it]))
    for (const it of r.valid) map.set(it.id, it)
    const merged = [...map.values()]
    setItems(merged)
    setOrders(computeOrders(merged))
    // 产品目录差分合并：hints 先行登记（占位名），内嵌 products 覆盖占位名（结合序保证等价于规格的分步合并）
    const incoming = mergeProducts(r.productHints, input.products ?? [])
    const diff = mergeProducts(products, incoming.merged)
    if (incoming.merged.length > 0) applyProducts(diff.merged)
    setImportReport({
      filename,
      imported: r.valid.length,
      skipped: r.skipped,
      unpublished: r.valid.filter((it) => it.publish_at > nowKey).length,
      noProduct: r.emptyProductCount,
      productsRegistered: r.productHints.length,
      productsDiff:
        incoming.merged.length > 0
          ? { added: diff.added, updated: diff.updated, kept: diff.unchanged }
          : undefined,
    })
  }

  const detailCard = detailCardId ? (items.find((c) => c.id === detailCardId) ?? null) : null

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-[#f4f5f7] text-slate-800">
      <TopBar
        total={items.length}
        coveredDays={coveredDays}
        dateStr={dateStr}
        onBackToToday={() => boardApiRef.current?.scrollToToday('smooth')}
        onAddToToday={addToToday}
        onOpenProducts={() => setProductsOpen(true)}
        onImportFile={handleImportFile}
      />
      <Board
        items={items}
        orders={orders}
        setItems={setItems}
        setOrders={setOrders}
        onOpenDetail={openDetail}
        onDelete={deleteCard}
        onAddCard={addCard}
        apiRef={boardApiRef}
      />
      <DetailDialog
        card={detailCard}
        autoEditTitle={detailAutoEdit}
        onClose={closeDetail}
        onUpdate={updateCard}
        onDelete={deleteCard}
      />
      <ProductManagerDialog
        open={productsOpen}
        products={products}
        items={items}
        onClose={() => setProductsOpen(false)}
        onApply={applyProducts}
      />
      <ImportResultDialog report={importReport} onClose={() => setImportReport(null)} />
    </div>
  )
}
