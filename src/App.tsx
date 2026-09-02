import { useEffect, useMemo, useRef, useState } from 'react'
import TopBar from '@/components/TopBar'
import Board, { type BoardApi } from '@/components/board/Board'
import DetailDialog from '@/components/board/DetailDialog'
import type { ContentItem, ContentType } from '@/types/content'
import {
  PRODUCTS,
  TYPE_KEYS,
  generateContent,
  pad2,
  todayStr,
  uid,
} from '@/lib/content-data'
import { nextOrder, publishDateOf, type Orders } from '@/lib/board-view'

const STORAGE_KEY = 'timeline-board-v3'
const PUBLISH_AT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/

interface PersistedState {
  items: ContentItem[]
  orders: Orders
}

// localStorage 持久化：启动时读取并校验，非法则重新生成假数据
function loadState(): PersistedState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed: unknown = JSON.parse(raw)
      const items = (parsed as PersistedState | null)?.items
      const orders = (parsed as PersistedState | null)?.orders
      if (
        Array.isArray(items) &&
        items.length > 0 &&
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
    }
  } catch {
    // 数据损坏时回落到假数据
  }
  return generateContent()
}

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六']

export default function App() {
  const [state, setState] = useState<PersistedState>(loadState)
  const { items, orders } = state
  // 详情弹窗：detailCardId = 打开的卡片；detailAutoEdit = 新增后标题直接进入编辑
  const [detailCardId, setDetailCardId] = useState<string | null>(null)
  const [detailAutoEdit, setDetailAutoEdit] = useState(false)
  const boardApiRef = useRef<BoardApi | null>(null)

  // 每次变更写入 localStorage
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
    } catch {
      // 存储不可用时静默降级为纯内存状态
    }
  }, [state])

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

  const updateCard = (id: string, patch: Partial<ContentItem>) =>
    setItems((prev) => prev.map((c) => (c.id === id ? { ...c, ...patch } : c)))

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

  const resetData = () => {
    closeDetail()
    setState(generateContent())
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
        onReset={resetData}
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
    </div>
  )
}
