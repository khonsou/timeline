import * as DialogPrimitive from '@radix-ui/react-dialog'
import { XIcon } from 'lucide-react'
import { Dialog, DialogOverlay, DialogPortal, DialogTitle } from '@/components/ui/dialog'
import type { SkippedRow } from '@timeline/core/import-core'

/** UI 增量导入的结果报告（成功与失败两态；失败时不落任何数据） */
export interface ImportReport {
  filename: string
  /** 解析失败 / 全无效时的错误信息（此时不落任何数据） */
  error?: string
  total?: number // 文件总条数（全无效错误时展示）
  imported?: number
  skipped?: SkippedRow[]
  unpublished?: number // 未发布条数（指标已强制置 null）
  noProduct?: number // 未填归属产品条数
  /** 自动登记的新产品数（未知 product_id + 可选 product_name；与 noProduct 区分展示） */
  productsRegistered?: number
  /** 产品目录差分结果（仅本次导入涉及产品时存在；全为 0 即纯幂等重合则不展示该行） */
  productsDiff?: { added: number; updated: number; kept: number }
  /** 自动登记的新成员数（未知负责人姓名，按姓名登记 M-1xxx；为 0 不展示该行） */
  membersRegistered?: number
}

interface ImportResultDialogProps {
  report: ImportReport | null // null = 关闭
  onClose: () => void
}

/** 导入结果报告弹窗（与 DetailDialog / 产品管理弹窗同一 Dialog 模式） */
export default function ImportResultDialog({ report, onClose }: ImportResultDialogProps) {
  return (
    <Dialog open={!!report} onOpenChange={(open) => !open && onClose()}>
      <DialogPortal>
        <DialogOverlay className="bg-slate-900/40 backdrop-blur-sm" />
        <DialogPrimitive.Content
          data-import-report
          className="data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 fixed left-[50%] top-[50%] z-50 flex max-h-[85vh] w-[calc(100vw-2rem)] max-w-lg translate-x-[-50%] translate-y-[-50%] flex-col overflow-hidden rounded-2xl border border-slate-200/80 bg-white/95 shadow-[0_24px_64px_-16px_rgba(15,23,42,0.35)] backdrop-blur duration-200 outline-none"
        >
          <DialogTitle className="sr-only">导入结果</DialogTitle>
          {report && (
            <>
              {/* 头部（固定不滚） */}
              <div className="flex shrink-0 items-center gap-2 border-b border-slate-100 px-6 pb-3 pt-4 shadow-[0_1px_3px_rgba(15,23,42,0.04)]">
                <h2 className="text-[15px] font-semibold text-slate-800">
                  {report.error ? '导入失败' : '导入完成'}
                </h2>
                <span className="max-w-[16rem] truncate text-[11px] text-slate-400">
                  {report.filename}
                </span>
                <DialogPrimitive.Close
                  aria-label="关闭导入报告"
                  className="ml-auto flex h-6 w-6 items-center justify-center rounded-full text-slate-400 outline-none transition-colors hover:bg-slate-100 hover:text-slate-600 focus-visible:ring-2 focus-visible:ring-indigo-200"
                >
                  <XIcon className="size-4" />
                </DialogPrimitive.Close>
              </div>

              {/* 内容区（独立滚动） */}
              <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4 [scrollbar-color:rgba(148,163,184,0.45)_transparent] [scrollbar-width:thin] [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-slate-300/50 [&::-webkit-scrollbar-track]:bg-transparent">
                {report.error ? (
                  <>
                    <p className="rounded-xl border border-rose-100 bg-rose-50/60 px-3 py-2.5 text-[13px] text-rose-600">
                      {report.error}
                      {typeof report.total === 'number' && `（文件共 ${report.total} 条）`}
                    </p>
                    <p className="mt-3 text-xs leading-relaxed text-slate-400">
                      未导入任何数据。支持 .json / .csv：JSON 为记录数组或{' '}
                      {'{ "items": [...], "products": [...] }'} 包裹；CSV 首行表头（中英文均可），
                      字段口径见 docs/cli-import-guide.md。
                    </p>
                    {report.skipped && report.skipped.length > 0 && (
                      <ul className="mt-3 space-y-1">
                        {report.skipped.map((s, i) => (
                          <li key={i} data-report-skip-row className="text-xs text-rose-500">
                            ✗ {s.row}: {s.reason}
                          </li>
                        ))}
                      </ul>
                    )}
                  </>
                ) : (
                  <>
                    <div className="grid grid-cols-4 gap-2">
                      <div className="rounded-xl bg-emerald-50/70 px-2 py-2 text-center">
                        <p className="text-lg font-semibold tabular-nums text-emerald-600" data-report-imported>
                          {report.imported ?? 0}
                        </p>
                        <p className="text-[10px] text-slate-400">导入条数</p>
                      </div>
                      <div className="rounded-xl bg-slate-50 px-2 py-2 text-center">
                        <p className="text-lg font-semibold tabular-nums text-slate-600" data-report-skipped>
                          {report.skipped?.length ?? 0}
                        </p>
                        <p className="text-[10px] text-slate-400">跳过条数</p>
                      </div>
                      <div className="rounded-xl bg-slate-50 px-2 py-2 text-center">
                        <p className="text-lg font-semibold tabular-nums text-slate-600" data-report-unpublished>
                          {report.unpublished ?? 0}
                        </p>
                        <p className="text-[10px] text-slate-400">未发布</p>
                      </div>
                      <div className="rounded-xl bg-slate-50 px-2 py-2 text-center">
                        <p className="text-lg font-semibold tabular-nums text-slate-600" data-report-noproduct>
                          {report.noProduct ?? 0}
                        </p>
                        <p className="text-[10px] text-slate-400">未填归属</p>
                      </div>
                    </div>
                    <p className="mt-3 text-[11px] leading-relaxed text-slate-400">
                      已按增量合并（同 id 覆盖、新 id 追加，列内顺序全量重算）；未发布内容的指标已强制置
                      null。产品目录为差分合并（只增/改，不删除；删产品请用「产品管理」）。
                    </p>
                    {report.productsDiff && (
                      <p
                        data-report-pdiff
                        className="mt-3 rounded-lg bg-indigo-50/60 px-3 py-2 text-xs text-indigo-600"
                      >
                        产品目录差分：新增 <b data-report-pdiff-added>{report.productsDiff.added}</b>
                        {' / '}更新 <b data-report-pdiff-updated>{report.productsDiff.updated}</b>
                        {' / '}保留 <b data-report-pdiff-kept>{report.productsDiff.kept}</b> 个产品
                        {report.productsDiff.added === 0 && report.productsDiff.updated === 0
                          ? '（目录无变化）'
                          : ''}
                      </p>
                    )}
                    {typeof report.productsRegistered === 'number' && report.productsRegistered > 0 && (
                      <p data-report-registered className="mt-2 text-xs text-emerald-600">
                        ✚ 自动登记新产品 {report.productsRegistered} 个（未知 product_id；缺名时以 id
                        占位，可在「产品管理」改名）
                      </p>
                    )}
                    {typeof report.membersRegistered === 'number' && report.membersRegistered > 0 && (
                      <p data-report-members-registered className="mt-2 text-xs text-emerald-600">
                        ✚ 自动登记新成员 {report.membersRegistered} 个（按姓名；删成员请用「成员管理」）
                      </p>
                    )}
                    {report.skipped && report.skipped.length > 0 && (
                      <div className="mt-3">
                        <p className="text-[10px] text-slate-400">跳过明细</p>
                        <ul className="mt-1 max-h-36 space-y-1 overflow-y-auto rounded-lg bg-slate-50/70 px-3 py-2">
                          {report.skipped.map((s, i) => (
                            <li key={i} data-report-skip-row className="text-xs text-rose-500">
                              ✗ {s.row}: {s.reason}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </>
                )}
              </div>

              {/* 底部（固定不滚） */}
              <div className="flex shrink-0 justify-end border-t border-slate-100 px-6 py-3">
                <DialogPrimitive.Close className="rounded-lg bg-slate-900 px-3 py-1.5 text-sm text-white transition-colors hover:bg-slate-700">
                  知道了
                </DialogPrimitive.Close>
              </div>
            </>
          )}
        </DialogPrimitive.Content>
      </DialogPortal>
    </Dialog>
  )
}
