/**
 * 亮/暗主题切换（v20 暗色主题）：
 * - 策略：Tailwind dark class——`<html>` 上挂/摘 `dark` 类，调色板经 CSS 变量双主题化
 *   （见 index.css 的 :root / .dark 变量表与 tailwind.config.js 的 var 化色板）
 * - 持久化：localStorage `timeline-theme`（'light' | 'dark'），缺省亮色；
 *   index.html 内联脚本首帧前预置 `dark` 类防闪烁，本 hook 接管后续切换
 */
import { useCallback, useEffect, useState } from 'react'

export type Theme = 'light' | 'dark'

const STORAGE_KEY = 'timeline-theme'

export function getInitialTheme(): Theme {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'dark' ? 'dark' : 'light'
  } catch {
    return 'light' // 存储不可用（隐私模式等）时按亮色
  }
}

function applyTheme(theme: Theme) {
  document.documentElement.classList.toggle('dark', theme === 'dark')
}

export function useTheme(): { theme: Theme; toggleTheme: () => void } {
  const [theme, setTheme] = useState<Theme>(getInitialTheme)

  // 与 index.html 预置脚本对齐：状态变化时同步 <html> 的 dark 类
  useEffect(() => {
    applyTheme(theme)
  }, [theme])

  const toggleTheme = useCallback(() => {
    setTheme((prev) => {
      const next = prev === 'dark' ? 'light' : 'dark'
      try {
        localStorage.setItem(STORAGE_KEY, next)
      } catch {
        // 存储不可用时仅本次会话生效
      }
      return next
    })
  }, [])

  return { theme, toggleTheme }
}
