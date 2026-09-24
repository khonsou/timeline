/**
 * D 期品牌面共享骨架（visual-upgrade-plan.md §4.2 + 设计方向 §3 开场构图）：
 * 首页 / AuthGate / PasswordGate 三个低频单屏共用——
 *   · 纯黑底全屏（bg-black 静态值，不随主题）；桌面左右边距 40px。
 *   · 上半部：眉题（拉丁全大写、12px、字距 0.3em、白 70%，font-mono）→ 48px 间隔 →
 *     主标题（中文现代黑体 42→56px、行距 1.05、字距略紧；次要词组由调用方用 text-white/40 弱化）。
 *   · 中下部：功能卡区（children；白容器浮层，左右分布由调用方 grid/flex 决定）。
 *   · 底部：左窄宽说明（白 60%）右主操作，跨画面平衡（§3）。
 * 深色锚定：根节点 brand-scope 把变量钉回亮色值（index.css），白容器/输入框/按钮恒为
 * 浅色容器语义；标题文字直接用 text-white/*（white 已被钉为 255 255 255）。
 * 入场：眉题 300 → 标题 500 → 说明 700 → 功能卡/操作 900ms 错峰（800ms ease-industrial，
 * 只播一次；motion-reduce 跳过——见 index.css .brand-enter / .brand-enter-scale）。
 * 只用于品牌面；看板工具面（BoardPage 主界面）不用。data-* 由调用方经 ...rest 落在根节点。
 */
import type { HTMLAttributes, ReactNode } from 'react'

interface BrandShellProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  /** 眉题（拉丁全大写；编号/短标记可嵌 font-dot） */
  eyebrow: ReactNode
  /** 主标题（中文黑体；弱化词组用 text-white/40 包裹） */
  title: ReactNode
  /** 底部左侧窄宽说明（白 60%） */
  note?: ReactNode
  /** 底部右侧主操作（industrial 按钮暗色变体 = 钉回后的黑壳橙块） */
  action?: ReactNode
  /** 功能卡区（画面中下部） */
  children?: ReactNode
}

export default function BrandShell({ eyebrow, title, note, action, children, className = '', ...rest }: BrandShellProps) {
  return (
    <div {...rest} className={`brand-scope flex min-h-screen flex-col bg-black text-white ${className}`}>
      {/* 上半部：眉题 → 主标题（间距 48px；顶部留白 112→160px 随屏高） */}
      <header className="px-6 pt-28 sm:px-10 sm:pt-40">
        <p
          className="brand-enter font-mono text-[12px] font-medium uppercase tracking-[0.3em] text-white/70"
          style={{ animationDelay: '300ms' }}
        >
          {eyebrow}
        </p>
        <h1
          className="brand-enter mt-12 max-w-3xl text-[42px] font-bold leading-[1.05] tracking-tight sm:text-[56px]"
          style={{ animationDelay: '500ms' }}
        >
          {title}
        </h1>
      </header>

      {/* 中下部功能卡区（白容器浮层；容器入场 95%→100% scale + fade） */}
      {children && (
        <main className="brand-enter-scale flex flex-1 flex-col justify-end px-6 pb-8 pt-10 sm:px-10" style={{ animationDelay: '900ms' }}>
          {children}
        </main>
      )}

      {/* 底部：左说明右操作（跨画面平衡）；pb-14 给左下角固定浮层（退出登录 pill）留位 */}
      {(note || action) && (
        <footer className="flex items-end justify-between gap-6 px-6 pb-14 sm:px-10">
          {note ? (
            <p className="brand-enter max-w-xs text-[13px] leading-relaxed text-white/60" style={{ animationDelay: '700ms' }}>
              {note}
            </p>
          ) : (
            <span />
          )}
          {action && (
            <div className="brand-enter shrink-0" style={{ animationDelay: '900ms' }}>
              {action}
            </div>
          )}
        </footer>
      )}
    </div>
  )
}
