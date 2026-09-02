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
