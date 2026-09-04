/** 表现层格式化工具 */

/**
 * 千分位缩写：12300 → "12.3k"，1800 → "1.8k"，200000 → "200k"，856 → "856"
 */
export function formatCompact(n: number): string {
  if (n < 1000) return String(n)
  const k = n / 1000
  const s = k >= 100 ? String(Math.round(k)) : String(Math.round(k * 10) / 10)
  return `${s}k`
}

/** ROI 展示：2.4 → "×2.4" */
export function formatRoi(r: number): string {
  return `×${r.toFixed(1)}`
}

const WEEK_LABELS = ['日', '一', '二', '三', '四', '五', '六']

/** publish_at 展示："YYYY-MM-DDTHH:mm" → "9月2日 周三 14:30" */
export function formatPublishAt(publishAt: string): string {
  const [datePart, timePart] = publishAt.split('T')
  const [y, m, d] = datePart.split('-').map(Number)
  const wd = WEEK_LABELS[new Date(y, m - 1, d).getDay()]
  return `${m}月${d}日 周${wd} ${timePart}`
}
