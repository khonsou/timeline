/**
 * v15 应用壳：极简 history 路由两个视图——
 *   `/`       → HomePage（看板列表：新建 / 打开 / 删除）
 *   `/b/:id`  → BoardPage（密码门 + 同步看板，v14 单板全部功能原样复用）
 */
import { useRoute } from '@/lib/router'
import HomePage from '@/pages/HomePage'
import BoardPage from '@/pages/BoardPage'

export default function App() {
  const route = useRoute()
  if (route.view === 'board') return <BoardPage key={route.boardId} boardId={route.boardId} />
  return <HomePage />
}
