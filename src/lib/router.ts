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
