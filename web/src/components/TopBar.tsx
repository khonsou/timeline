import { useRef } from 'react'
import { Boxes, Moon, Sun, Upload, Users } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTheme } from '@/hooks/useTheme'
import { CAPACITY_WARN_AT, MAX_CARDS } from '@/lib/content-data'

export type SyncDot = 'loading' | 'synced' | 'syncing' | 'offline'

interface TopBarProps {
  total: number
  coveredDays: number
  dateStr: string
  /** v15：看板名（列表页返回链接旁展示） */
  boardName?: string
  /** v15：同步状态指示（已同步/同步中/离线） */
  syncStatus?: SyncDot
  /** v15：返回看板列表 */
  onBackHome?: () => void
  onBackToToday: () => void
  onAddToToday: () => void
  onOpenProducts: () => void
  onOpenMembers: () => void
  onImportFile: (file: File) => void
}

const SYNC_META: Record<SyncDot, { dot: string; text: string; title: string }> = {
  loading: { dot: 'bg-slate-300', text: '加载中', title: '正在从服务器拉取看板…' },
  synced: { dot: 'bg-emerald-500', text: '已同步', title: '与服务器一致' },
  syncing: { dot: 'bg-amber-400 animate-pulse', text: '同步中', title: '正在与服务器同步…' },
  offline: { dot: 'bg-rose-400', text: '离线', title: '网络不可达：改动已存本机缓存，恢复后自动补推' },
}

export default function TopBar({
  total,
  coveredDays,
  dateStr,
  boardName,
  syncStatus,
  onBackHome,
  onBackToToday,
  onAddToToday,
  onOpenProducts,
  onOpenMembers,
  onImportFile,
}: TopBarProps) {
  const fileRef = useRef<HTMLInputElement>(null)
  const { theme, toggleTheme } = useTheme()
  const sync = syncStatus ? SYNC_META[syncStatus] : null
  // v16 容量警示：≥1500 提示剩余额度 + 按时间切片新建看板；≥2000 禁用加卡/导入
  const capacityFull = total >= MAX_CARDS
  const capacityWarn = total >= CAPACITY_WARN_AT

  return (
    <header className="z-20 shrink-0 border-b border-slate-200/80 bg-white/85 backdrop-blur">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
        <div className="flex items-baseline gap-3">
          {onBackHome && (
            <button
              type="button"
              data-back-home
              onClick={onBackHome}
              className="text-xs text-slate-400 transition-colors hover:text-slate-600"
            >
              ← 列表
            </button>
          )}
          <h1 className="text-[15px] font-bold tracking-tight text-slate-800">
            拾光轴 · Timeline Board
          </h1>
          {boardName && (
            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-500" data-board-name>
              {boardName}
            </span>
          )}
          <p className="text-xs tabular-nums text-slate-400">{dateStr}</p>
        </div>

        <div className="ml-auto flex items-center gap-2 sm:gap-3">
          {sync && (
            <span
              data-sync-status={syncStatus}
              title={sync.title}
              className="flex items-center gap-1.5 text-[11px] text-slate-400"
            >
              <span className={`h-1.5 w-1.5 rounded-full ${sync.dot}`} />
              {sync.text}
            </span>
          )}
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
          {capacityWarn && (
            <span
              data-capacity-hint
              className={`flex items-center gap-2 rounded-full px-2.5 py-1 text-[11px] font-medium ${
                capacityFull ? 'bg-rose-50 text-rose-600' : 'bg-amber-50 text-amber-600'
              }`}
            >
              {capacityFull ? `已达上限 ${MAX_CARDS} 张` : `还可添加 ${MAX_CARDS - total} 张`}
              {onBackHome && (
                <button
                  type="button"
                  data-capacity-split
                  onClick={onBackHome}
                  className="underline underline-offset-2 transition-colors hover:text-indigo-600"
                >
                  按时间切片新建看板
                </button>
              )}
            </span>
          )}
          {/* 卡片增量导入：隐藏 file input，读取后走共享 import-core 解析校验（merge 语义） */}
          <input
            ref={fileRef}
            type="file"
            accept=".json,.csv"
            data-import-input
            className="hidden"
            disabled={capacityFull}
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) onImportFile(f)
              e.target.value = '' // 允许重复选择同一文件（幂等由内容哈希 id 保证）
            }}
          />
          <Button size="sm" variant="ghost" onClick={onOpenProducts} data-products-btn>
            <Boxes className="size-3.5" />
            产品管理
          </Button>
          <Button size="sm" variant="ghost" onClick={onOpenMembers} data-members-btn>
            <Users className="size-3.5" />
            成员管理
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={capacityFull}
            onClick={() => fileRef.current?.click()}
            data-import-btn
          >
            <Upload className="size-3.5" />
            导入
          </Button>
          <Button size="sm" variant="ghost" onClick={onBackToToday}>
            ⌖ 回到今天
          </Button>
          <Button size="sm" disabled={capacityFull} onClick={onAddToToday}>
            + 空卡片
          </Button>
          {/* v20 暗色主题切换：顶栏最右，localStorage 持久化（useTheme） */}
          <Button
            size="sm"
            variant="ghost"
            onClick={toggleTheme}
            data-theme-toggle
            aria-label={theme === 'dark' ? '切换到亮色主题' : '切换到暗色主题'}
            title={theme === 'dark' ? '切换到亮色主题' : '切换到暗色主题'}
          >
            {theme === 'dark' ? <Sun className="size-3.5" /> : <Moon className="size-3.5" />}
          </Button>
        </div>
      </div>
    </header>
  )
}
