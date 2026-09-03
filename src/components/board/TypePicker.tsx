import { useEffect, useRef, useState } from 'react'
import type { ContentType } from '@/types/content'
import { TAGS, TYPE_KEYS } from '@/lib/content-data'

interface TypePickerProps {
  value: ContentType
  onChange: (t: ContentType) => void
  /** 展开态上报父级：纳入弹窗 Esc 拦截（选择器展开时 Esc 只关选择器、不关弹窗） */
  onOpenChange?: (open: boolean) => void
}

/**
 * 类型选择器：头部彩色胶囊可点击，下方展开 5 类胶囊横排小弹层（popover）。
 * 点选即保存并关闭；Esc / 点击外部关闭且不改动。卡片面上的胶囊保持只读，
 * 编辑入口统一在详情弹窗。
 */
export default function TypePicker({ value, onChange, onOpenChange }: TypePickerProps) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  const setOpenSafe = (o: boolean) => {
    setOpen(o)
    onOpenChange?.(o)
  }

  // 展开时：点击外部 / Esc 关闭（不改动）。
  // Esc 走 document 监听：与 Radix DismissableLayer 同级，两条链路独立——
  // 这里负责关选择器；弹窗是否关闭由 DetailDialog 的 onEscapeKeyDown
  // 依据 typePickerOpen（展开态）preventDefault 拦截。
  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpenSafe(false)
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpenSafe(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // 卸载兜底：确保父级展开态复位
  useEffect(() => () => onOpenChange?.(false), [onOpenChange])

  const tag = TAGS[value]

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        data-type-trigger
        title="点击更换类型"
        aria-expanded={open}
        onClick={() => setOpenSafe(!open)}
        className={`inline-flex cursor-pointer items-center gap-1 rounded-full px-2 py-0.5 text-[11px] outline-none transition-shadow hover:ring-2 hover:ring-indigo-200 focus-visible:ring-2 focus-visible:ring-indigo-200 ${tag.pill}`}
      >
        <span className={`h-1.5 w-1.5 rounded-full ${tag.dot}`} />
        {value}
      </button>
      {open && (
        <div className="absolute left-0 top-full z-10 mt-1.5 flex gap-1.5 rounded-xl border border-slate-200/80 bg-white p-2 shadow-[0_12px_28px_-10px_rgba(15,23,42,0.30)]">
          {TYPE_KEYS.map((t) => {
            const tt = TAGS[t]
            const active = t === value
            return (
              <button
                key={t}
                type="button"
                data-type-option={t}
                onClick={() => {
                  if (!active) onChange(t)
                  setOpenSafe(false)
                }}
                className={`inline-flex cursor-pointer items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] outline-none transition-shadow hover:ring-2 hover:ring-indigo-200 focus-visible:ring-2 focus-visible:ring-indigo-200 ${tt.pill} ${active ? 'ring-2 ring-indigo-400' : ''}`}
              >
                <span className={`h-1.5 w-1.5 rounded-full ${tt.dot}`} />
                {t}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
