/**
 * v15 多用户看板 API 客户端（纯 fetch，同源 /api 由 vite proxy / nginx 反代）。
 * token 存 sessionStorage（按 board_id 键）：关标签页即失效，12h 服务端过期。
 */
import type { BoardDoc } from '@/lib/board-doc'

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
  constructor(status: number, message: string, retryAfter?: number) {
    super(message)
    this.status = status
    this.retryAfter = retryAfter
  }
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response
  try {
    res = await fetch(path, init)
  } catch (e) {
    // 网络层失败（断网 / server 未起）：status 0 供同步层判离线
    throw new ApiError(0, e instanceof Error ? e.message : String(e))
  }
  if (res.status === 204) return undefined as T
  let body: { error?: string; retry_after?: number } = {}
  try {
    body = await res.json()
  } catch {
    // 非 JSON 响应（不应发生）
  }
  if (!res.ok) {
    throw new ApiError(res.status, body.error ?? `HTTP ${res.status}`, body.retry_after)
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

export const putBoard = (boardId: string, doc: BoardDoc) =>
  req<{ version: number }>(`/api/boards/${boardId}`, {
    ...authed(boardId),
    method: 'PUT',
    headers: { 'content-type': 'application/json', ...authed(boardId).headers },
    body: JSON.stringify({ doc }),
  })

export const deleteBoard = (boardId: string, password: string) =>
  req<void>(`/api/boards/${boardId}`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password }),
  })
