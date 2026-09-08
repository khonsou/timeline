/**
 * v15 极简 history 路由（~40 行，不引 react-router）：
 * 两个视图：`/` 看板列表页、`/b/:id` 看板页；其余路径落到列表页。
 * navigate() 通过 pushState + 自定义事件通知；popstate（前进/后退）同步。
 */
import { useEffect, useState } from 'react'

export type Route = { view: 'home' } | { view: 'board'; boardId: string }

const NAV_EVENT = 'timeline-board:navigate'

export function parseRoute(pathname: string): Route {
  const m = /^\/b\/([0-9a-f]{16})\/?$/.exec(pathname)
  if (m) return { view: 'board', boardId: m[1] }
  return { view: 'home' }
}

export function navigate(to: string) {
  window.history.pushState(null, '', to)
  window.dispatchEvent(new Event(NAV_EVENT))
}

// ---------------------------------------------------------------------------
// 看板页 hash 参数（v2-M1 F6 分享链接；M3 视图状态预留 view 参数）：
//   /b/:boardId#card=<contentId>            打开后定位并高亮卡片
//   /b/:boardId#view=graph&card=<id>        参数可组合、可缺省（URLSearchParams 语义）
// ---------------------------------------------------------------------------
export interface BoardHashParams {
  /** 定位卡片 id（F6 分享定位编号，直接复用 ContentItem.id） */
  card?: string
  /** 视图名（M3 预留：graph 关系视图；M1 仅透传解析，不消费） */
  view?: string
}

/** 解析 location.hash 中的看板参数；空 hash / 非法参数一律缺省 */
export function parseBoardHash(hash: string): BoardHashParams {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash
  const q = new URLSearchParams(raw)
  const out: BoardHashParams = {}
  const card = q.get('card')
  const view = q.get('view')
  if (card) out.card = card
  if (view) out.view = view
  return out
}

/** 构造看板分享 URL（参数缺省则不出现；顺序固定 view → card 便于阅读） */
export function buildBoardUrl(boardId: string, params: BoardHashParams = {}): string {
  const q = new URLSearchParams()
  if (params.view) q.set('view', params.view)
  if (params.card) q.set('card', params.card)
  const h = q.toString()
  return `${window.location.origin}/b/${boardId}${h ? `#${h}` : ''}`
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.pathname))
  useEffect(() => {
    const update = () => setRoute(parseRoute(window.location.pathname))
    window.addEventListener('popstate', update)
    window.addEventListener(NAV_EVENT, update)
    return () => {
      window.removeEventListener('popstate', update)
      window.removeEventListener(NAV_EVENT, update)
    }
  }, [])
  return route
}
