export function formatTokens(value: number): string {
  if (value < 1_000) return Math.round(value).toLocaleString('zh-CN')
  if (value < 1_000_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}K`
  if (value < 100_000_000) {
    return `${(value / 1_000_000).toFixed(value < 10_000_000 ? 2 : 1)}M`
  }
  const precision = value < 1_000_000_000 ? 2 : 1
  const formatted = (value / 100_000_000).toFixed(precision).replace(/\.?0+$/, '')
  return `${formatted}亿`
}
