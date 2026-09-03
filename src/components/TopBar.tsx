import { Button } from '@/components/ui/button'

interface TopBarProps {
  total: number
  coveredDays: number
  dateStr: string
  onBackToToday: () => void
  onAddToToday: () => void
}

export default function TopBar({
  total,
  coveredDays,
  dateStr,
  onBackToToday,
  onAddToToday,
}: TopBarProps) {
  return (
    <header className="z-20 shrink-0 border-b border-slate-200/80 bg-white/85 backdrop-blur">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
        <div className="flex items-baseline gap-3">
          <h1 className="text-[15px] font-bold tracking-tight text-slate-800">
            拾光轴 · Timeline Board
          </h1>
          <p className="text-xs tabular-nums text-slate-400">{dateStr}</p>
        </div>

        <div className="ml-auto flex items-center gap-2 sm:gap-3">
          <div className="hidden items-center gap-3 text-xs text-slate-500 sm:flex">
            <span>
              共 <span className="font-semibold tabular-nums text-slate-700">{total}</span> 张卡片
            </span>
            <span className="h-3 w-px bg-slate-200" />
            <span>
              覆盖{' '}
              <span className="font-semibold tabular-nums text-slate-700">{coveredDays}</span> 天
            </span>
          </div>
          <Button size="sm" variant="ghost" onClick={onBackToToday}>
            ⌖ 回到今天
          </Button>
          <Button size="sm" onClick={onAddToToday}>
            + 空卡片
          </Button>
        </div>
      </div>
    </header>
  )
}
