/**
 * OAuth 回调页（/oauth/callback）：按文档 §7.2 顺序处理 ——
 *   1. 读 query 的 error / code / state
 *   2. 有 error → 可理解的失败信息，不调 Token Endpoint（access_denied = 已取消登录）
 *   3. 读取并删除 pending；无 pending 直接失败
 *   4. 严格比较 state
 *   5. code exchange 建立内存会话
 *   6. 替换地址栏（不留 code/state），仅跳同源校验过的 return_to
 * 错误页面不回显 token / code / 完整授权 URL（文档 §9）。
 */
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { exchangeCode, startOauthLogin, takePendingAuth } from '@/lib/auth'
import { navigate, replaceLocation } from '@/lib/router'

/** StrictMode 双跑守卫：同一 code+state 只处理一次（code 一次性，二次 exchange 必败且会误报） */
const processedCodes = new Set<string>()

export default function AuthCallbackPage() {
  // 同步可判定的失败（error 分支 / 参数缺失）直接作初始 state——纯读 location，无副作用；
  // effect 内只做异步链路（校验 + exchange），避免同步 setState 触发级联渲染
  const [failure, setFailure] = useState<string | null>(() => {
    const q = new URLSearchParams(window.location.search)
    const error = q.get('error')
    // 2. error 分支：不调 Token Endpoint
    if (error) return error === 'access_denied' ? '已取消登录' : '登录失败，请重新尝试'
    if (!q.get('code') || !q.get('state')) return '登录回调参数缺失，请重新登录'
    return null
  })

  useEffect(() => {
    if (failure !== null) return // 初始 state 已判定失败（error / 参数缺失）
    const q = new URLSearchParams(window.location.search)
    const code = q.get('code') as string
    const state = q.get('state') as string
    const key = `${code}::${state}`
    if (processedCodes.has(key)) return
    processedCodes.add(key)
    // 3–7. pending 一次性消费 → state 严格比较 → exchange → 清理地址栏跳同源 return_to；
    // 统一入微任务：校验失败与 exchange 失败同一路径渲染
    void Promise.resolve()
      .then(() => {
        const pending = takePendingAuth()
        if (!pending) throw new Error('登录状态已过期，请重新登录')
        if (state !== pending.state) throw new Error('登录状态校验失败，请重新登录')
        return exchangeCode(code, pending.code_verifier).then(() => replaceLocation(pending.return_to))
      })
      .catch((e) => setFailure(e instanceof Error ? e.message : '登录失败，请重新登录'))
  }, [failure])

  return (
    <div
      className="flex min-h-screen items-center justify-center bg-page text-slate-800"
      data-oauth-callback
    >
      <div className="w-[calc(100vw-2rem)] max-w-sm rounded-2xl border border-slate-200/80 bg-white/90 p-6 text-center shadow-sm">
        {failure ? (
          <>
            <p className="text-[15px] font-semibold" data-oauth-error>
              {failure}
            </p>
            <Button
              data-oauth-retry
              className="mt-4 w-full"
              onClick={() => void startOauthLogin('/')}
            >
              重新登录
            </Button>
            <button
              type="button"
              onClick={() => navigate('/')}
              className="mt-3 w-full text-center text-[12px] text-slate-400 hover:text-slate-600"
            >
              ← 返回首页
            </button>
          </>
        ) : (
          <p className="text-[13px] text-slate-500">正在完成登录…</p>
        )}
      </div>
    </div>
  )
}
