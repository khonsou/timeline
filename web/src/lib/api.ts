/**
 * v15 多用户看板 API 客户端（纯 fetch，同源 /api 由 vite proxy / nginx 反代）。
 * token 存 sessionStorage（按 board_id 键）：关标签页即失效，12h 服务端过期。
 */
import type { BoardDoc } from '@/lib/board-doc'

const BASE_PATH = import.meta.env.BASE_URL === '/' ? '' : import.meta.env.BASE_URL.replace(/\/$/, '')
export const apiPath = (path: string): string => `${BASE_PATH}${path}`

export interface BoardSummary {
  board_id: string
  name: string
  version: number
  cards: number
  updated_at: string
}

export class ApiError extends Error {
  status: number
  retryAfter?: number
  /** 409 VERSION_CONFLICT 时服务端返回的当前版本 */
  currentVersion?: number
  constructor(status: number, message: string, retryAfter?: number, currentVersion?: number) {
    super(message)
    this.status = status
    this.retryAfter = retryAfter
    this.currentVersion = currentVersion
  }
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response
  try {
    res = await fetch(apiPath(path), init)
  } catch (e) {
    // 网络层失败（断网 / server 未起）：status 0 供同步层判离线
    throw new ApiError(0, e instanceof Error ? e.message : String(e))
  }
  if (res.status === 204) return undefined as T
  let body: { error?: string; retry_after?: number; current_version?: number } = {}
  try {
    body = await res.json()
  } catch {
    // 非 JSON 响应（不应发生）
  }
  if (!res.ok) {
    throw new ApiError(res.status, body.error ?? `HTTP ${res.status}`, body.retry_after, body.current_version)
  }
  return body as T
}

// ---------------------------------------------------------------------------
// token 存取（sessionStorage 按板键）
// ---------------------------------------------------------------------------
const tokenKey = (boardId: string) => `timeline-board-v4:token:${boardId}`
export const getToken = (boardId: string): string | null => {
  try {
    return sessionStorage.getItem(tokenKey(boardId))
  } catch {
    return null
  }
}
export const setToken = (boardId: string, token: string) => {
  try {
    sessionStorage.setItem(tokenKey(boardId), token)
  } catch {
    // 存储不可用时仅内存态不可用——下次刷新重新输密码
  }
}
export const clearToken = (boardId: string) => {
  try {
    sessionStorage.removeItem(tokenKey(boardId))
  } catch {
    // ignore
  }
}

const authed = (boardId: string): RequestInit => {
  const t = getToken(boardId)
  return t ? { headers: { authorization: `Bearer ${t}` } } : {}
}

// ---------------------------------------------------------------------------
// 6 个接口
// ---------------------------------------------------------------------------
export const listBoards = () => req<{ boards: BoardSummary[] }>('/api/boards')

export const createBoard = (name: string, password: string, doc?: BoardDoc) =>
  req<{ board_id: string }>('/api/boards', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(doc ? { name, password, doc } : { name, password }),
  })

export const authBoard = (boardId: string, password: string) =>
  req<{ token: string; expires_at: string }>(`/api/boards/${boardId}/auth`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password }),
  })

export const getBoard = (boardId: string, version?: number) =>
  req<{ changed: boolean; doc?: BoardDoc; version: number }>(
    `/api/boards/${boardId}${version === undefined ? '' : `?version=${version}`}`,
    authed(boardId),
  )

/**
 * 整板 PUT（M4 起携带 If-Match 版本保护）。
 * version 省略（-1，从未与远端对齐）→ 兼容模式无版本头，服务端放行但标记 Deprecation。
 * 409 时抛出 ApiError（status 409 + currentVersion），由同步层走 pending-patch 重放恢复。
 */
export const putBoard = (boardId: string, doc: BoardDoc, version?: number) =>
  req<{ version: number }>(`/api/boards/${boardId}`, {
    ...authed(boardId),
    method: 'PUT',
    headers: {
      'content-type': 'application/json',
      ...authed(boardId).headers,
      ...(version !== undefined && version >= 0 ? { 'if-match': String(version) } : {}),
    },
    body: JSON.stringify({ doc }),
  })

export const deleteBoard = (boardId: string, password: string) =>
  req<void>(`/api/boards/${boardId}`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password }),
  })
