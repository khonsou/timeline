/**
 * v15 应用壳：极简 history 路由三个视图——
 *   `/`               → HomePage（看板列表：新建 / 打开 / 删除）
 *   `/b/:id`          → BoardPage（密码门 + 同步看板，v14 单板全部功能原样复用）
 *   `/oauth/callback` → AuthCallbackPage（OAuth Phase 0 回调；不进 AuthGate）
 * OAuth Phase 0：home/board 统一包 AuthGate（全站先过统一账号登录，看板密码门不变）。
 */
import { useRoute } from '@/lib/router'
import HomePage from '@/pages/HomePage'
import BoardPage from '@/pages/BoardPage'
import AuthCallbackPage from '@/pages/AuthCallbackPage'
import AuthGate from '@/components/AuthGate'

export default function App() {
  const route = useRoute()
  if (route.view === 'authCallback') return <AuthCallbackPage />
  return (
    <AuthGate>
      {route.view === 'board' ? <BoardPage key={route.boardId} boardId={route.boardId} /> : <HomePage />}
    </AuthGate>
  )
}
