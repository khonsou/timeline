/**
 * v15 看板页（`/b/:id`）：密码门 → 同步看板。
 *
 * 组成：
 *  1. PasswordGate：无 token 时的密码输入页（auth 换 12h token 存 sessionStorage）；
 *     看板不存在 → 提示 + 返回列表
 *  2. SyncedBoard：v14 单板 App 原样复用，持久化替换为同步层（见下方状态机注释）
 *
 * 同步层状态机（syncStatus）：
 *   loading →（缓存首帧 + 首次全量 GET）→ synced
 *   本地变更 → 写缓存 + 置 dirty → 防抖 500ms PUT → synced（syncing 过渡）
 *   每 5s（?poll=ms 可覆盖）轮询：dirty 则先补推，否则带 version GET；
 *     changed → 整板替换本地 state（含 products/members 目录，LWW 后写覆盖先写）
 *   网络失败 → offline（继续编辑，缓存兜底；恢复后 tick 补推，接受被覆盖）
 *   401（token 过期）→ 清 token 回密码门；404 → 看板不存在页
 * 本地缓存：localStorage `timeline-board-v4:b:<boardId>` 存整份 doc（离线可编辑）。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import TopBar from '@/components/TopBar'
import Board, { type BoardApi } from '@/components/board/Board'
import DetailDialog from '@/components/board/DetailDialog'
import ProductManagerDialog from '@/components/board/ProductManagerDialog'
import MemberManagerDialog from '@/components/board/MemberManagerDialog'
import ImportResultDialog, { type ImportReport } from '@/components/board/ImportResultDialog'
import { Button } from '@/components/ui/button'
import type { ContentItem, Member } from '@timeline/core/types'
import {
  MAX_CARDS,
  MEMBERS,
  PRODUCTS,
  TYPE_KEYS,
  pad2,
  setRuntimeMembers,
  setRuntimeProducts,
  todayStr,
  uid,
  type Product,
} from '@/lib/content-data'
import { nextOrder, publishDateOf, type Orders } from '@timeline/core/board-view'
import {
  computeOrders,
  mergeMembers,
  mergeProducts,
  readItemsInput,
  validateItems,
} from '@timeline/core/import-core'
import { validateDoc, type BoardDoc } from '@/lib/board-doc'
import {
  ApiError,
  authBoard,
  clearToken,
  getBoard,
  getToken,
  listBoards,
  putBoard,
  setToken,
} from '@/lib/api'
import { navigate } from '@/lib/router'

// ---------------------------------------------------------------------------
// 密码门
// ---------------------------------------------------------------------------
function PasswordGate({ boardId, onAuthed }: { boardId: string; onAuthed: () => void }) {
  const [boardName, setBoardName] = useState<string | null>(null)
  const [notFound, setNotFound] = useState(false)
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    listBoards()
      .then((r) => {
        const b = r.boards.find((x) => x.board_id === boardId)
        if (b) setBoardName(b.name)
        else setNotFound(true)
      })
      .catch(() => setError('API server 未启动或不可达'))
  }, [boardId])

  const submit = async () => {
    if (!password || busy) return
    setBusy(true)
    setError(null)
    try {
      const { token } = await authBoard(boardId, password)
      setToken(boardId, token)
      onAuthed()
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) setNotFound(true)
      else setError(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-[#f4f5f7] text-slate-800" data-gate>
      <div className="w-[calc(100vw-2rem)] max-w-sm rounded-2xl border border-slate-200/80 bg-white/90 p-6 shadow-sm">
        {notFound ? (
          <div className="text-center" data-gate-notfound>
            <p className="text-[15px] font-semibold">看板不存在或已删除</p>
            <p className="mt-2 text-[12px] text-slate-400">它可能已被其他成员物理删除（不可恢复）</p>
            <Button className="mt-5" onClick={() => navigate('/')}>
              返回看板列表
            </Button>
          </div>
        ) : (
          <>
            <h1 className="text-[15px] font-semibold">
              进入看板{boardName ? `「${boardName}」` : ''}
            </h1>
            <p className="mt-1 text-[12px] text-slate-400" data-gate-name>
              {boardName ?? '校验看板中…'}
            </p>
            <input
              data-gate-password
              type="password"
              autoFocus
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && submit()}
              placeholder="访问密码…"
              className="mt-4 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-[13px] focus:outline-none focus:ring-2 focus:ring-indigo-200"
            />
            {error && (
              <p className="mt-2 text-[12px] text-rose-500" data-gate-error>
                {error}
              </p>
            )}
            <Button
              data-gate-submit
              className="mt-4 w-full"
              disabled={!password || busy || boardName === null}
              onClick={submit}
            >
              {busy ? '校验中…' : '进入看板'}
            </Button>
            <button
              type="button"
              onClick={() => navigate('/')}
              className="mt-3 w-full text-center text-[12px] text-slate-400 hover:text-slate-600"
            >
              ← 返回看板列表
            </button>
          </>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// 同步看板（v14 单板 App + 同步层）
// ---------------------------------------------------------------------------
type SyncStatus = 'loading' | 'synced' | 'syncing' | 'offline'

interface PersistedState {
  items: ContentItem[]
  orders: Orders
}

const cacheKey = (boardId: string) => `timeline-board-v4:b:${boardId}`

function readCache(boardId: string): BoardDoc | null {
  try {
    const raw = localStorage.getItem(cacheKey(boardId))
    if (!raw) return null
    return validateDoc(JSON.parse(raw))
  } catch {
    return null
  }
}

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六']

function SyncedBoard({
  boardId,
  onUnauthorized,
}: {
  boardId: string
  onUnauthorized: () => void
}) {
  // 首帧同步读缓存（离线/慢网也能立即看到内容），随后全量 GET 接管
  const [initialCache] = useState<BoardDoc | null>(() => readCache(boardId))
  const [state, setState] = useState<PersistedState>(() => ({
    items: initialCache?.items ?? [],
    orders: initialCache?.orders ?? {},
  }))
  const { items, orders } = state
  const [products, setProducts] = useState<Product[]>(() => {
    const p = initialCache?.products ?? PRODUCTS
    setRuntimeProducts(p)
    return p
  })
  const [members, setMembers] = useState<Member[]>(() => {
    const m = initialCache?.members ?? MEMBERS
    setRuntimeMembers(m)
    return m
  })
  const [syncStatus, setSyncStatus] = useState<SyncStatus>(initialCache ? 'syncing' : 'loading')
  const [notFound, setNotFound] = useState(false)
  const [boardName, setBoardName] = useState(initialCache?.meta.name ?? '')

  // 详情弹窗等 UI 态（与 v14 一致）
  const [detailCardId, setDetailCardId] = useState<string | null>(null)
  const [detailAutoEdit, setDetailAutoEdit] = useState(false)
  const [productsOpen, setProductsOpen] = useState(false)
  const [membersOpen, setMembersOpen] = useState(false)
  const [importReport, setImportReport] = useState<ImportReport | null>(null)
  const boardApiRef = useRef<BoardApi | null>(null)

  // ------------------------------------------------------------------
  // 同步层：refs 镜像最新状态，供异步回调（防抖/轮询/flush）读取
  // ------------------------------------------------------------------
  const metaRef = useRef(initialCache?.meta ?? { name: '', created_at: '' })
  const docRef = useRef<BoardDoc>({
    items: state.items,
    orders: state.orders,
    products,
    members,
    meta: metaRef.current,
  })
  const versionRef = useRef<number>(-1) // -1 = 尚未与远端对齐（首次必须全量拉）
  const dirtyRef = useRef(false)
  const pushingRef = useRef(false)
  const suppressDirtyRef = useRef(false) // 应用远端 doc 时不回标 dirty（防 ping-pong）
  const pushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const statusRef = useRef<SyncStatus>(syncStatus)
  statusRef.current = syncStatus

  // 测试/调优钩子：?poll=ms 轮询间隔（默认 5000）、?push=ms 推送防抖（默认 500）
  const timings = useMemo(() => {
    const q = new URLSearchParams(window.location.search)
    const poll = Number(q.get('poll'))
    const push = Number(q.get('push'))
    return {
      poll: Number.isFinite(poll) && poll >= 200 ? poll : 5000,
      push: Number.isFinite(push) && push >= 50 ? push : 500,
    }
  }, [])

  const applyRemoteDoc = (doc: BoardDoc) => {
    suppressDirtyRef.current = true
    setRuntimeProducts(doc.products)
    setRuntimeMembers(doc.members)
    setProducts(doc.products)
    setMembers(doc.members)
    setState({ items: doc.items, orders: doc.orders })
    metaRef.current = doc.meta
    setBoardName(doc.meta.name)
  }

  const handleSyncError = (e: unknown): boolean => {
    if (e instanceof ApiError && e.status === 401) {
      clearToken(boardId)
      onUnauthorized()
      return true
    }
    if (e instanceof ApiError && e.status === 404) {
      setNotFound(true)
      return true
    }
    setSyncStatus('offline') // 网络层失败：缓存兜底，恢复后补推
    return false
  }

  const pull = async (withVersion: boolean) => {
    try {
      const r = await getBoard(boardId, withVersion && versionRef.current >= 0 ? versionRef.current : undefined)
      if (r.changed && r.doc) {
        const doc = validateDoc(r.doc)
        if (doc) applyRemoteDoc(doc)
      }
      versionRef.current = r.version
      setSyncStatus('synced')
    } catch (e) {
      handleSyncError(e)
    }
  }

  const push = async () => {
    if (pushingRef.current || !dirtyRef.current) return
    pushingRef.current = true
    setSyncStatus((s) => (s === 'offline' ? s : 'syncing'))
    try {
      const r = await putBoard(boardId, docRef.current)
      versionRef.current = r.version
      dirtyRef.current = false
      setSyncStatus('synced')
    } catch (e) {
      handleSyncError(e) // dirty 保持 true，下个 tick 补推
    } finally {
      pushingRef.current = false
    }
  }

  const tick = () => {
    if (pushingRef.current) return
    if (dirtyRef.current) void push()
    else void pull(true)
  }

  // 首次全量拉取 + 轮询 + online 恢复 + pagehide flush
  useEffect(() => {
    void pull(false)
    const timer = setInterval(tick, timings.poll)
    const onOnline = () => tick()
    const flush = () => {
      if (!dirtyRef.current) return
      const token = getToken(boardId)
      if (!token) return
      // pagehide 时用 keepalive 尽力补推（页面即将关闭，不等响应）
      void fetch(`/api/boards/${boardId}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ doc: docRef.current }),
        keepalive: true,
      }).catch(() => {})
    }
    window.addEventListener('online', onOnline)
    window.addEventListener('pagehide', flush)
    return () => {
      clearInterval(timer)
      window.removeEventListener('online', onOnline)
      window.removeEventListener('pagehide', flush)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boardId])

  // 状态镜像 → docRef；本地变更 → 写缓存 + 标 dirty + 防抖推送
  useEffect(() => {
    docRef.current = { items, orders, products, members, meta: metaRef.current }
    try {
      localStorage.setItem(cacheKey(boardId), JSON.stringify(docRef.current))
    } catch {
      // 存储不可用时仅内存生效
    }
    if (suppressDirtyRef.current) {
      suppressDirtyRef.current = false // 远端应用落盘后不标 dirty
      return
    }
    dirtyRef.current = true
    setSyncStatus((s) => (s === 'offline' || s === 'loading' ? s : 'syncing'))
    if (pushTimerRef.current) clearTimeout(pushTimerRef.current)
    pushTimerRef.current = setTimeout(() => void push(), timings.push)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, orders, products, members])

  // ------------------------------------------------------------------
  // 以下为 v14 单板逻辑（updateCard/deleteCard/addCard/handleImportFile），原样保留
  // ------------------------------------------------------------------
  const applyProducts = (next: Product[]) => {
    setRuntimeProducts(next)
    setProducts(next)
  }
  const applyMembers = (next: Member[]) => {
    setRuntimeMembers(next)
    setMembers(next)
  }

  const dateStr = useMemo(() => {
    const now = new Date()
    return `${now.getFullYear()} 年 ${now.getMonth() + 1} 月 ${now.getDate()} 日 · 星期${WEEKDAYS[now.getDay()]}`
  }, [])
  const coveredDays = useMemo(() => new Set(items.map((c) => publishDateOf(c))).size, [items])

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
    const newPublishAt = patch.publish_at
    if (typeof newPublishAt === 'string') {
      const item = items.find((c) => c.id === id)
      if (item) {
        const newDate = newPublishAt.slice(0, 10)
        if (newDate !== publishDateOf(item)) {
          const order = nextOrder(items, orders, newDate)
          setOrders((prev) => ({ ...prev, [id]: order }))
          // v16 B2：日期改出当前窗口时视野跟随到新日期（窗口内则平滑滚动过去）
          boardApiRef.current?.revealDate(newDate)
        }
      }
    }
    // v14：切到非「已发布」→ 三指标强制置 null；改 publish_at 不再置 null
    if (typeof patch.status === 'string' && patch.status !== '已发布') {
      patch = { ...patch, roi: null, propagation_4h: null, engagement_4h: null }
    }
    setItems((prev) => prev.map((c) => (c.id === id ? { ...c, ...patch } : c)))
  }

  const deleteCard = (id: string) => {
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

  const addCard = (date: string) => {
    if (items.length >= MAX_CARDS) return // v16 容量上限（UI 已禁用，这里兜底）
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
      status: '待执行',
      content_owner_id: '',
      delivery_owner_id: '',
    }
    setItems((prev) => [...prev, item])
    setOrders((prev) => ({ ...prev, [id]: order }))
    setDetailAutoEdit(true)
    setDetailCardId(id)
  }

  const addToToday = () => addCard(todayStr())

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
      knownProducts: new Set([...products.map((p) => p.id), ...(input.products ?? []).map((p) => p.id)]),
      knownMembers: new Map(members.map((m) => [m.name, m.id])),
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
    const map = new Map(items.map((it) => [it.id, it]))
    for (const it of r.valid) map.set(it.id, it)
    const merged = [...map.values()]
    // v16 容量上限：合并后超限 → 整体拒绝导入（不落任何数据）
    if (merged.length > MAX_CARDS) {
      setImportReport({
        filename,
        error: `合并后共 ${merged.length} 张，超过单板上限 ${MAX_CARDS} 张，已整体拒绝导入（请按时间切片拆分或新建看板）`,
        total: input.records.length,
        skipped: r.skipped,
      })
      return
    }
    setItems(merged)
    setOrders(computeOrders(merged))
    const incoming = mergeProducts(r.productHints, input.products ?? [])
    const diff = mergeProducts(products, incoming.merged)
    if (incoming.merged.length > 0) applyProducts(diff.merged)
    const mdiff = mergeMembers(members, r.memberHints)
    if (r.memberHints.length > 0) applyMembers(mdiff.merged)
    setImportReport({
      filename,
      imported: r.valid.length,
      skipped: r.skipped,
      unpublished: r.valid.filter((it) => it.status !== '已发布').length,
      noProduct: r.emptyProductCount,
      productsRegistered: r.productHints.length,
      productsDiff:
        incoming.merged.length > 0
          ? { added: diff.added, updated: diff.updated, kept: diff.unchanged }
          : undefined,
      membersRegistered: r.memberHints.length,
    })
  }

  const detailCard = detailCardId ? (items.find((c) => c.id === detailCardId) ?? null) : null

  if (notFound) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#f4f5f7]" data-board-notfound>
        <div className="text-center">
          <p className="text-[15px] font-semibold">看板不存在或已删除</p>
          <p className="mt-2 text-[12px] text-slate-400">它可能已被其他成员物理删除（不可恢复）</p>
          <Button className="mt-5" onClick={() => navigate('/')}>
            返回看板列表
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-[#f4f5f7] text-slate-800">
      <TopBar
        total={items.length}
        coveredDays={coveredDays}
        dateStr={dateStr}
        boardName={boardName}
        syncStatus={syncStatus}
        onBackHome={() => navigate('/')}
        onBackToToday={() => boardApiRef.current?.scrollToToday('smooth')}
        onAddToToday={addToToday}
        onOpenProducts={() => setProductsOpen(true)}
        onOpenMembers={() => setMembersOpen(true)}
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
        canAdd={items.length < MAX_CARDS}
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
      <MemberManagerDialog
        open={membersOpen}
        members={members}
        items={items}
        onClose={() => setMembersOpen(false)}
        onApply={applyMembers}
      />
      <ImportResultDialog report={importReport} onClose={() => setImportReport(null)} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// 页面入口：token 在 → 直接进板；不在 → 密码门；401 → 清 token 回密码门
// ---------------------------------------------------------------------------
export default function BoardPage({ boardId }: { boardId: string }) {
  const [authed, setAuthed] = useState(() => !!getToken(boardId))
  if (!authed) return <PasswordGate boardId={boardId} onAuthed={() => setAuthed(true)} />
  return (
    <SyncedBoard
      boardId={boardId}
      onUnauthorized={() => {
        clearToken(boardId)
        setAuthed(false)
      }}
    />
  )
}
