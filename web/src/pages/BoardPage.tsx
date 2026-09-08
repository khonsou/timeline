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
 *   本地变更 → 写缓存 + 记 pending-patch → 防抖 500ms 带 If-Match PUT → synced（syncing 过渡）
 *   每 5s（?poll=ms 可覆盖）轮询：dirty 则先补推，否则带 version GET；
 *     changed → 远端快照成为新 base，本地 pending-patch 重放其上（item 字段级合并，
 *     不再整板覆盖本地未推送编辑）
 *   PUT 409 VERSION_CONFLICT → conflict（冲突恢复中）：整板 GET → pending 重放到最新快照
 *     → 带新 version 重试；连续 409 退避后再试一次；最终失败 → conflict-failed
 *     （顶栏「冲突需刷新」手动入口，编辑保留在 localStorage 不丢）
 *   网络失败 → offline（继续编辑，缓存兜底；恢复后 tick 补推，走同一 pending 重放路径）
 *   401（token 过期）→ 清 token 回密码门；404 → 看板不存在页
 * 本地缓存：localStorage `timeline-board-v4:b:<boardId>` 存整份 doc + `_sync`
 * （对齐版本 version + 未推送 pending-patch），刷新后未推送编辑仍可重放。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import TopBar from '@/components/TopBar'
import Board, { type BoardApi } from '@/components/board/Board'
import DetailDialog from '@/components/board/DetailDialog'
import ProductManagerDialog from '@/components/board/ProductManagerDialog'
import MemberManagerDialog from '@/components/board/MemberManagerDialog'
import ImportResultDialog, { type ImportReport } from '@/components/board/ImportResultDialog'
import SearchPalette from '@/components/board/SearchPalette'
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
  applyPatch,
  diffDocs,
  emptyPatch,
  patchIsEmpty,
  sanitizePatch,
  type DocPatch,
} from '@/lib/pending-patch'
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
import { buildBoardUrl, navigate, parseBoardHash } from '@/lib/router'

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
type SyncStatus = 'loading' | 'synced' | 'syncing' | 'offline' | 'conflict' | 'conflict-failed'

interface PersistedState {
  items: ContentItem[]
  orders: Orders
}

const cacheKey = (boardId: string) => `timeline-board-v4:b:${boardId}`

/** M4：缓存 = 整份 doc（顶层键不变，兼容既有读取）+ `_sync`（对齐版本 + 未推送 pending-patch） */
interface CachedBoard {
  doc: BoardDoc
  /** 缓存 doc 对齐到的服务端版本；-1 = 未知（旧格式缓存） */
  version: number
  /** 缓存中尚未推送的本地变更（相对对齐版本的差分） */
  pending: DocPatch
}

function readCache(boardId: string): CachedBoard | null {
  try {
    const raw = localStorage.getItem(cacheKey(boardId))
    if (!raw) return null
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const doc = validateDoc(parsed)
    if (!doc) return null
    const sync = (parsed._sync ?? null) as { version?: unknown; pending?: unknown } | null
    const version = typeof sync?.version === 'number' ? sync.version : -1
    return { doc, version, pending: sanitizePatch(sync?.pending) }
  } catch {
    return null
  }
}

const sleepMs = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六']

function SyncedBoard({
  boardId,
  onUnauthorized,
}: {
  boardId: string
  onUnauthorized: () => void
}) {
  // 首帧同步读缓存（离线/慢网也能立即看到内容），随后全量 GET 接管
  const [initialCache] = useState<CachedBoard | null>(() => readCache(boardId))
  const [state, setState] = useState<PersistedState>(() => ({
    items: initialCache?.doc.items ?? [],
    orders: initialCache?.doc.orders ?? {},
  }))
  const { items, orders } = state
  const [products, setProducts] = useState<Product[]>(() => {
    const p = initialCache?.doc.products ?? PRODUCTS
    setRuntimeProducts(p)
    return p
  })
  const [members, setMembers] = useState<Member[]>(() => {
    const m = initialCache?.doc.members ?? MEMBERS
    setRuntimeMembers(m)
    return m
  })
  const [syncStatus, setSyncStatus] = useState<SyncStatus>(initialCache ? 'syncing' : 'loading')
  const [notFound, setNotFound] = useState(false)
  const [boardName, setBoardName] = useState(initialCache?.doc.meta.name ?? '')

  // 详情弹窗等 UI 态（与 v14 一致）
  const [detailCardId, setDetailCardId] = useState<string | null>(null)
  const [detailAutoEdit, setDetailAutoEdit] = useState(false)
  const [productsOpen, setProductsOpen] = useState(false)
  const [membersOpen, setMembersOpen] = useState(false)
  const [importReport, setImportReport] = useState<ImportReport | null>(null)
  const boardApiRef = useRef<BoardApi | null>(null)

  // v2-M1：F5 搜索面板开关 / F6 分享链接 toast / 分享定位目标
  const [searchOpen, setSearchOpen] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** 分享链接 #card= 目标（仅首次进板消费一次；hash 保留在地址栏，刷新可复现） */
  const shareCardRef = useRef<string | null>(parseBoardHash(window.location.hash).card ?? null)
  /** 首次全量 GET 已完成（成功失败皆算——失败时以缓存为准，避免离线白等） */
  const [loaded, setLoaded] = useState(false)

  const showToast = (msg: string) => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current)
    setToast(msg)
    toastTimerRef.current = setTimeout(() => setToast(null), 2500)
  }
  useEffect(
    () => () => {
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current)
    },
    [],
  )

  // F6：复制卡片分享链接（/b/:id#card=<contentId>，不绕过密码门）；剪贴板不可用时 execCommand 兜底
  const copyShareLink = async (id: string) => {
    const url = buildBoardUrl(boardId, { card: id })
    try {
      await navigator.clipboard.writeText(url)
    } catch {
      const ta = document.createElement('textarea')
      ta.value = url
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      try {
        document.execCommand('copy')
      } catch {
        // 两种写剪贴板方式都失败时仍提示（链接本身已生成，用户可手动复制地址栏）
      }
      ta.remove()
    }
    showToast('分享链接已复制')
  }

  // F5：⌘K / Ctrl+K 唤起/关闭搜索面板（输入框内同样生效，与 Board 的无修饰键导航不冲突）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault()
        setSearchOpen((v) => !v)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // ------------------------------------------------------------------
  // 同步层：refs 镜像最新状态，供异步回调（防抖/轮询/flush）读取
  // M4：baseRef = 与服务端对齐的快照；pendingRef = diff(base, 本地 doc)，
  // 推送/轮询/409 恢复都把它重放到最新快照之上（组件层无感，仍读写同一个 doc state）
  // ------------------------------------------------------------------
  const metaRef = useRef(initialCache?.doc.meta ?? { name: '', created_at: '' })
  const docRef = useRef<BoardDoc>({
    items: state.items,
    orders: state.orders,
    products,
    members,
    meta: metaRef.current,
  })
  const versionRef = useRef<number>(initialCache?.version ?? -1) // -1 = 尚未与远端对齐（首次必须全量拉）
  const baseRef = useRef<BoardDoc | null>(null) // versionRef 所指版本的内容；首次拉取/推送成功后建立
  const pendingRef = useRef<DocPatch>(initialCache?.pending ?? emptyPatch())
  const dirtyRef = useRef(!patchIsEmpty(pendingRef.current))
  const pushingRef = useRef(false)
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

  /** 重算 pending = diff(base, 本地 doc) 并派生 dirty（base 未建立时保留缓存带来的 pending） */
  const refreshPending = () => {
    if (baseRef.current) {
      pendingRef.current = diffDocs(baseRef.current, docRef.current)
      dirtyRef.current = !patchIsEmpty(pendingRef.current)
    } else {
      dirtyRef.current = !patchIsEmpty(pendingRef.current)
    }
  }

  const persistCache = () => {
    try {
      localStorage.setItem(
        cacheKey(boardId),
        JSON.stringify({
          ...docRef.current,
          _sync: { version: versionRef.current, pending: pendingRef.current },
        }),
      )
    } catch {
      // 存储不可用时仅内存生效
    }
  }

  const schedulePush = (delay = timings.push) => {
    if (pushTimerRef.current) clearTimeout(pushTimerRef.current)
    pushTimerRef.current = setTimeout(() => void push(), delay)
  }

  const applyRemoteDoc = (doc: BoardDoc) => {
    setRuntimeProducts(doc.products)
    setRuntimeMembers(doc.members)
    setProducts(doc.products)
    setMembers(doc.members)
    setState({ items: doc.items, orders: doc.orders })
    metaRef.current = doc.meta
    setBoardName(doc.meta.name)
  }

  /**
   * 远端快照落本地（M4 统一入口）：
   *   merged = 远端快照 + pending0（拉取开始时的本地未推送变更）
   *   finalDoc = merged + late（拉取/推送 await 窗口内用户的新编辑，diff(l0, live) 捕获）
   * 仅在 finalDoc 与用户当前所见不一致时才动 React state（避免打断正在进行的输入）。
   */
  const adoptRemote = (remote: BoardDoc, version: number, l0: BoardDoc, pending0: DocPatch) => {
    const merged = patchIsEmpty(pending0) ? remote : applyPatch(remote, pending0)
    const live = docRef.current
    const late = diffDocs(l0, live)
    const finalDoc = patchIsEmpty(late) ? merged : applyPatch(merged, late)
    baseRef.current = merged
    versionRef.current = version
    pendingRef.current = diffDocs(merged, finalDoc)
    dirtyRef.current = !patchIsEmpty(pendingRef.current)
    if (!patchIsEmpty(diffDocs(live, finalDoc))) {
      applyRemoteDoc(finalDoc) // state 变更 → 镜像 effect 重算 pending 并落缓存
    } else {
      persistCache()
    }
    if (dirtyRef.current) schedulePush()
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
    const l0 = docRef.current
    const pending0 = pendingRef.current
    try {
      const r = await getBoard(boardId, withVersion && versionRef.current >= 0 ? versionRef.current : undefined)
      if (r.changed && r.doc) {
        const doc = validateDoc(r.doc)
        if (doc) {
          adoptRemote(doc, r.version, l0, pending0)
          if (!dirtyRef.current) setSyncStatus('synced')
          return
        }
      }
      versionRef.current = r.version
      if (!dirtyRef.current) setSyncStatus('synced')
    } catch (e) {
      handleSyncError(e)
    } finally {
      setLoaded(true) // v2-M1 F6：首次全量 GET 落定后才消费 #card= 定位
    }
  }

  /**
   * 409 恢复：整板 GET 拉最新快照 → pending 重放 → 带新 version 重试 PUT。
   * 连续 409（罕见，第三方并发写）退避后再试一次；最终失败 → conflict-failed，
   * 编辑保留在 pending + localStorage，顶栏提供手动刷新入口。
   */
  const recoverFromConflict = async (attempt: number): Promise<void> => {
    setSyncStatus('conflict')
    const l0 = docRef.current
    const pending0 = pendingRef.current
    try {
      const r = await getBoard(boardId) // 全量拉最新
      const serverDoc = validateDoc(r.doc)
      if (!serverDoc) throw new Error('远端 doc 校验失败')
      const merged = applyPatch(serverDoc, pending0)
      const r2 = await putBoard(boardId, merged, r.version)
      adoptRemote(merged, r2.version, l0, emptyPatch())
      setSyncStatus(dirtyRef.current ? 'syncing' : 'synced')
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        if (attempt < 2) {
          await sleepMs(700 + Math.floor(Math.random() * 400)) // 退避后再试一次
          return recoverFromConflict(attempt + 1)
        }
        setSyncStatus('conflict-failed') // 连续冲突：手动刷新入口，不静默丢编辑
        return
      }
      if (e instanceof ApiError && (e.status === 401 || e.status === 404)) {
        handleSyncError(e)
        return
      }
      if (e instanceof ApiError && e.status === 0) {
        setSyncStatus('offline') // 恢复中途断网：dirty 保留，online/tick 再走补推
        return
      }
      setSyncStatus('conflict-failed')
    }
  }

  const push = async () => {
    if (pushingRef.current || !dirtyRef.current) return
    pushingRef.current = true
    const sent = docRef.current
    setSyncStatus((s) => (s === 'offline' || s === 'conflict' || s === 'conflict-failed' ? s : 'syncing'))
    try {
      const r = await putBoard(boardId, sent, versionRef.current)
      adoptRemote(sent, r.version, sent, emptyPatch()) // base = 已推送快照；await 窗口内的新编辑留作 pending
      if (!dirtyRef.current) setSyncStatus('synced')
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        await recoverFromConflict(1)
      } else {
        handleSyncError(e) // dirty 保持 true，下个 tick 补推
      }
    } finally {
      pushingRef.current = false
    }
  }

  const tick = () => {
    if (pushingRef.current) return
    if (statusRef.current === 'conflict-failed') return // 等手动刷新入口，不自动风暴重试
    if (dirtyRef.current) void push()
    else void pull(true)
  }

  // 首次全量拉取 + 轮询 + online 恢复 + pagehide flush
  useEffect(() => {
    void pull(false)
    const timer = setInterval(tick, timings.poll)
    const onOnline = () => {
      if (statusRef.current !== 'conflict-failed') tick()
    }
    const flush = () => {
      if (!dirtyRef.current) return
      const token = getToken(boardId)
      if (!token) return
      // pagehide 时用 keepalive 尽力补推（页面即将关闭，不等响应；409 由下次打开时 pending 重放兜底）
      void fetch(`/api/boards/${boardId}`, {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
          ...(versionRef.current >= 0 ? { 'if-match': String(versionRef.current) } : {}),
        },
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

  // 状态镜像 → docRef；重算 pending → 写缓存（doc + _sync）；有未推送变更 → 防抖推送
  useEffect(() => {
    docRef.current = { items, orders, products, members, meta: metaRef.current }
    refreshPending()
    persistCache()
    if (!dirtyRef.current) return
    setSyncStatus((s) =>
      s === 'offline' || s === 'loading' || s === 'conflict' || s === 'conflict-failed' ? s : 'syncing',
    )
    schedulePush()
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
    setItems((prev) =>
      prev.map((c) => {
        if (c.id !== id) return c
        const next = { ...c, ...patch }
        // v2-M1：patch 值 undefined = 移除该可选字段（bg_color 恢复默认 / dimmed 点亮），
        // 避免把 undefined 键写进 doc（JSON 序列化虽会丢弃，但内存态保持干净）
        for (const [k, v] of Object.entries(patch)) {
          if (v === undefined) delete (next as unknown as Record<string, unknown>)[k]
        }
        return next
      }),
    )
  }

  // v2-M1 F2：置灰/点亮 toggle（undefined/false = 正常，置灰再点 = 移除字段点亮）
  const toggleDimmed = (id: string) => {
    const c = items.find((x) => x.id === id)
    if (!c) return
    updateCard(id, { dimmed: c.dimmed === true ? undefined : true })
  }

  // v2-M1b F1：设置背景色（写 hex 自有属性）；null = 选「默认」，移除字段
  const setBgColor = (id: string, hex: string | null) => {
    updateCard(id, { bg_color: hex ?? undefined })
  }

  // v2-M1 F6：消费分享链接 #card= 定位——首次全量 GET 落定后执行一次；
  // 卡片已删除 → 正常开板 + toast 提示（不报错不白屏）
  useEffect(() => {
    const target = shareCardRef.current
    if (!target || !loaded) return
    const api = boardApiRef.current
    if (!api) return
    shareCardRef.current = null
    if (items.some((c) => c.id === target)) api.revealCard(target)
    else showToast('卡片不存在或已删除')
  }, [items, syncStatus, loaded])

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
        onSyncRefresh={() => void recoverFromConflict(1)}
        onBackHome={() => navigate('/')}
        onBackToToday={() => boardApiRef.current?.scrollToToday('smooth')}
        onAddToToday={addToToday}
        onOpenProducts={() => setProductsOpen(true)}
        onOpenMembers={() => setMembersOpen(true)}
        onImportFile={handleImportFile}
        onOpenSearch={() => setSearchOpen(true)}
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
        onSetBgColor={setBgColor}
        onToggleDimmed={toggleDimmed}
        onCopyShareLink={(id) => void copyShareLink(id)}
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
      {/* v2-M1 F5 看板内搜索（全量 items，含窗口外卡片；定位走 Board.revealCard） */}
      <SearchPalette
        open={searchOpen}
        items={items}
        orders={orders}
        products={products}
        members={members}
        onClose={() => setSearchOpen(false)}
        onLocate={(id) => boardApiRef.current?.revealCard(id)}
        onCopyLink={(id) => void copyShareLink(id)}
      />
      {/* v2-M1 轻量 toast（分享链接复制确认 / 卡片已删除提示） */}
      {toast && (
        <div
          data-toast
          className="fixed bottom-20 left-1/2 z-[60] -translate-x-1/2 rounded-full bg-slate-800/90 px-4 py-2 text-[12px] text-white shadow-[0_10px_28px_-10px_rgba(15,23,42,0.45)]"
        >
          {toast}
        </div>
      )}
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
