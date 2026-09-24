/**
 * OAuth Phase 0 全站登录门（docs/oauth-auth-integration.md §6）：
 * 无 OAuth 会话时任何路由（含 /b/:id 深链）先显示统一登录页，一键整页跳转 Auth 授权；
 * 登录后一切照旧——进入具体看板仍走 BoardPage 原有密码门（双层登录模型，文档 §1/§8）。
 * 登录页不写死产品名：授权页显示的应用名由 Auth Client 配置提供（文档 §3），此处文案保持中性。
 */
import { useEffect, useState, type ReactNode } from 'react'
import { ArrowRight } from 'lucide-react'
import { Button, INDUSTRIAL_ICON_CLASSES } from '@/components/ui/button'
import { getOauthSession, oauthLogout, startOauthLogin, subscribeAuth } from '@/lib/auth'
import { useRoute } from '@/lib/router'

export default function AuthGate({ children }: { children: ReactNode }) {
  const [authed, setAuthed] = useState(() => getOauthSession() !== null)
  useEffect(() => subscribeAuth(() => setAuthed(getOauthSession() !== null)), [])
  const route = useRoute()

  if (!authed) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-page text-slate-800" data-auth-gate>
        <div className="w-[calc(100vw-2rem)] max-w-sm rounded-2xl border border-slate-200/80 bg-white/90 p-6 text-center shadow-sm">
          <h1 className="text-[15px] font-semibold">统一账号登录</h1>
          <p className="mt-2 text-[12px] leading-relaxed text-slate-400">
            使用团队统一账号登录后继续。
            <br />
            进入具体看板仍需输入该看板的访问密码。
          </p>
          <Button
            variant="industrial"
            data-oauth-login
            className="mt-5 w-full"
            onClick={() => void startOauthLogin()}
          >
            <span className={INDUSTRIAL_ICON_CLASSES}>
              <ArrowRight className="size-5" />
            </span>
            使用统一账号登录
          </Button>
        </div>
      </div>
    )
  }

  return (
    <>
      {children}
      {/* 退出入口只放首页（列表页），看板页不浮层遮挡交互（Phase 0 最小侵入） */}
      {route.view === 'home' && (
        <button
          type="button"
          data-oauth-logout
          onClick={oauthLogout}
          title="退出统一账号登录（不影响已输入的看板密码）"
          className="fixed bottom-3 left-3 z-40 rounded-full bg-white/80 px-2.5 py-1 text-[11px] text-slate-400 shadow-sm ring-1 ring-slate-200/80 transition-colors hover:text-slate-600"
        >
          退出登录
        </button>
      )}
    </>
  )
}
