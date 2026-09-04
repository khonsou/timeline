/**
 * v15 看板列表页（`/`）：
 *  - 极简表格：看板名 / 更新时间 / 卡片数 / version + 每行「打开」「删除」
 *  - 新建看板：名称 + 密码；勾选「从本机现有数据初始化」则打包 v14 本机数据
 *    （旧 localStorage 单板 / CLI board.json），否则用 2 张引导卡种子
 *  - 删除：确认框列出将失去的内容（名称/卡片数/最后更新）→ 输该板密码 → 物理删除
 */
import { useEffect, useState } from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { XIcon } from 'lucide-react'
import { Dialog, DialogOverlay, DialogPortal, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import {
  ApiError,
  authBoard,
  createBoard,
  deleteBoard,
  listBoards,
  setToken,
  type BoardSummary,
} from '@/lib/api'
import { loadLegacyLocal, guideDoc, type LegacyData } from '@/lib/board-doc'
import { navigate } from '@/lib/router'

function fmtTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

export default function HomePage() {
  const [boards, setBoards] = useState<BoardSummary[] | null>(null)
  const [listError, setListError] = useState<string | null>(null)
  const [legacy, setLegacy] = useState<LegacyData | null>(null)

  // 新建表单
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [useLegacy, setUseLegacy] = useState(true)
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)

  // 删除确认
  const [deleting, setDeleting] = useState<BoardSummary | null>(null)
  const [deletePassword, setDeletePassword] = useState('')
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [deleteBusy, setDeleteBusy] = useState(false)

  const refresh = () => {
    listBoards()
      .then((r) => {
        setBoards(r.boards)
        setListError(null)
      })
      .catch((e) => setListError(e instanceof ApiError && e.status === 0 ? 'API server 未启动或不可达' : String(e)))
  }
  useEffect(refresh, [])
  useEffect(() => {
    loadLegacyLocal().then(setLegacy)
  }, [])

  const doCreate = async () => {
    const n = name.trim()
    if (!n || !password || creating) return
    setCreating(true)
    setCreateError(null)
    try {
      const doc =
        useLegacy && legacy
          ? { ...legacy, meta: { name: n, created_at: new Date().toISOString() } }
          : guideDoc(n)
      const { board_id } = await createBoard(n, password, doc)
      // 创建即代表持有密码：直接 auth 换 token 进板，少一次输入
      const { token } = await authBoard(board_id, password)
      setToken(board_id, token)
      navigate(`/b/${board_id}`)
    } catch (e) {
      setCreateError(e instanceof Error ? e.message : String(e))
      setCreating(false)
    }
  }

  const doDelete = async () => {
    if (!deleting || !deletePassword || deleteBusy) return
    setDeleteBusy(true)
    setDeleteError(null)
    try {
      await deleteBoard(deleting.board_id, deletePassword)
      setDeleting(null)
      setDeletePassword('')
      refresh()
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : String(e))
    } finally {
      setDeleteBusy(false)
    }
  }

  return (
    <div className="min-h-screen bg-[#f4f5f7] text-slate-800" data-home>
      <div className="mx-auto max-w-3xl px-6 py-10">
        <header className="mb-8">
          <h1 className="text-xl font-bold tracking-tight">拾光轴 · Timeline Board</h1>
          <p className="mt-1 text-xs text-slate-400">多用户看板服务 —— 选择一块看板进入，或新建一块</p>
        </header>

        {/* 新建看板 */}
        <section className="rounded-2xl border border-slate-200/80 bg-white/90 p-5 shadow-sm">
          <h2 className="text-[14px] font-semibold">新建看板</h2>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <input
              data-create-name
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="看板名称…"
              className="min-w-40 flex-1 rounded-lg border border-slate-200 bg-white px-3 py-2 text-[13px] focus:outline-none focus:ring-2 focus:ring-indigo-200"
            />
            <input
              data-create-password
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && doCreate()}
              placeholder="访问密码（进入/删除都需要）…"
              className="min-w-40 flex-1 rounded-lg border border-slate-200 bg-white px-3 py-2 text-[13px] focus:outline-none focus:ring-2 focus:ring-indigo-200"
            />
            <Button data-create-btn onClick={doCreate} disabled={!name.trim() || !password || creating}>
              {creating ? '创建中…' : '创建看板'}
            </Button>
          </div>
          <label className="mt-3 flex cursor-pointer items-center gap-2 text-[12px] text-slate-500">
            <input
              data-create-init
              type="checkbox"
              checked={useLegacy && !!legacy}
              disabled={!legacy}
              onChange={(e) => setUseLegacy(e.target.checked)}
              className="accent-slate-700 disabled:opacity-40"
            />
            从本机现有数据初始化
            {legacy ? (
              <span className="text-slate-400" data-legacy-hint>
                （检测到 {legacy.items.length} 张卡片 · {legacy.products.length} 个产品 · {legacy.members.length} 名成员）
              </span>
            ) : (
              <span className="text-slate-300" data-legacy-hint>
                （本机暂无可初始化数据）
              </span>
            )}
          </label>
          {createError && <p className="mt-2 text-[12px] text-rose-500">{createError}</p>}
        </section>

        {/* 看板列表 */}
        <section className="mt-6 rounded-2xl border border-slate-200/80 bg-white/90 shadow-sm">
          <div className="border-b border-slate-100 px-5 py-3">
            <h2 className="text-[14px] font-semibold">
              看板列表
              <span className="ml-2 text-[11px] font-normal tabular-nums text-slate-400">
                {boards?.length ?? 0} 块
              </span>
            </h2>
          </div>
          {listError ? (
            <p className="px-5 py-8 text-center text-[13px] text-rose-500" data-list-error>
              {listError}
            </p>
          ) : boards === null ? (
            <p className="px-5 py-8 text-center text-[13px] text-slate-300">加载中…</p>
          ) : boards.length === 0 ? (
            <p className="px-5 py-8 text-center text-[13px] text-slate-300" data-list-empty>
              还没有看板，先建一块吧
            </p>
          ) : (
            <table className="w-full text-[13px]" data-board-table>
              <thead>
                <tr className="text-left text-[11px] text-slate-400">
                  <th className="px-5 py-2 font-normal">看板名</th>
                  <th className="px-3 py-2 font-normal">更新时间</th>
                  <th className="px-3 py-2 font-normal">卡片数</th>
                  <th className="px-3 py-2 font-normal">version</th>
                  <th className="px-3 py-2 font-normal" />
                </tr>
              </thead>
              <tbody>
                {boards.map((b) => (
                  <tr
                    key={b.board_id}
                    data-board-row
                    data-board-id={b.board_id}
                    className="border-t border-slate-50 transition-colors hover:bg-slate-50/60"
                  >
                    <td className="px-5 py-2.5">
                      <button
                        type="button"
                        data-board-open
                        onClick={() => navigate(`/b/${b.board_id}`)}
                        className="font-medium text-slate-700 hover:text-indigo-600 hover:underline"
                      >
                        {b.name}
                      </button>
                    </td>
                    <td className="px-3 py-2.5 tabular-nums text-slate-500" data-board-updated>
                      {fmtTime(b.updated_at)}
                    </td>
                    <td className="px-3 py-2.5 tabular-nums text-slate-500" data-board-cards>
                      {b.cards}
                    </td>
                    <td className="px-3 py-2.5 tabular-nums text-slate-400">v{b.version}</td>
                    <td className="px-3 py-2.5 text-right">
                      <button
                        type="button"
                        data-board-delete
                        onClick={() => {
                          setDeleting(b)
                          setDeletePassword('')
                          setDeleteError(null)
                        }}
                        className="rounded-lg px-2 py-1 text-[12px] text-rose-500 transition-colors hover:bg-rose-50"
                      >
                        删除
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>

      {/* 删除确认框：列出将失去的内容 + 重新输密码（物理删除不可恢复） */}
      <Dialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)}>
        <DialogPortal>
          <DialogOverlay className="bg-slate-900/40 backdrop-blur-sm" />
          <DialogPrimitive.Content
            data-delete-dialog
            className="data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 fixed left-[50%] top-[50%] z-50 w-[calc(100vw-2rem)] max-w-md translate-x-[-50%] translate-y-[-50%] rounded-2xl border border-slate-200/80 bg-white/95 p-6 shadow-[0_24px_64px_-16px_rgba(15,23,42,0.35)] backdrop-blur duration-200 outline-none"
          >
            <DialogTitle className="sr-only">删除看板</DialogTitle>
            <DialogPrimitive.Close
              aria-label="关闭删除确认"
              className="absolute right-4 top-4 flex h-6 w-6 items-center justify-center rounded-full text-slate-400 outline-none transition-colors hover:bg-slate-100 hover:text-slate-600"
            >
              <XIcon className="size-4" />
            </DialogPrimitive.Close>
            {deleting && (
              <>
                <h3 className="text-[15px] font-semibold text-slate-800">删除看板「{deleting.name}」？</h3>
                <div className="mt-3 rounded-xl bg-rose-50/60 px-3 py-2.5 text-[12px] leading-relaxed text-rose-600">
                  <p>物理删除不可恢复，将永久失去：</p>
                  <ul className="mt-1 list-inside list-disc">
                    <li>
                      看板名称：<b data-delete-name>{deleting.name}</b>
                    </li>
                    <li>
                      内容卡片：<b data-delete-cards>{deleting.cards}</b> 张
                    </li>
                    <li>
                      最后更新：<span data-delete-updated>{fmtTime(deleting.updated_at)}</span>
                    </li>
                  </ul>
                </div>
                <input
                  data-delete-password
                  type="password"
                  value={deletePassword}
                  onChange={(e) => setDeletePassword(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && doDelete()}
                  placeholder="输入该看板的访问密码以确认删除…"
                  className="mt-4 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-[13px] focus:outline-none focus:ring-2 focus:ring-rose-200"
                />
                {deleteError && <p className="mt-2 text-[12px] text-rose-500" data-delete-error>{deleteError}</p>}
                <div className="mt-4 flex justify-end gap-2">
                  <Button variant="ghost" onClick={() => setDeleting(null)}>
                    取消
                  </Button>
                  <button
                    type="button"
                    data-delete-confirm
                    onClick={doDelete}
                    disabled={!deletePassword || deleteBusy}
                    className="rounded-lg bg-rose-600 px-3 py-1.5 text-[13px] text-white transition-colors hover:bg-rose-500 disabled:cursor-not-allowed disabled:opacity-30"
                  >
                    {deleteBusy ? '删除中…' : '确认删除'}
                  </button>
                </div>
              </>
            )}
          </DialogPrimitive.Content>
        </DialogPortal>
      </Dialog>
    </div>
  )
}
