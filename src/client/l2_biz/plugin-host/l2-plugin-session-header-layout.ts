export function calculateL2PluginSessionHeaderInlineCount(
  widths: readonly number[],
  availableWidth: number,
  moreWidth: number,
  gap: number
): number {
  const occupiedCount = widths.filter((width) => width > 0).length
  const total = widths.reduce((sum, width) => sum + width, 0) + Math.max(0, occupiedCount - 1) * gap
  if (total <= availableWidth) return widths.length

  let used = moreWidth
  let count = 0
  for (const width of widths) {
    if (width > 0) {
      if (used + gap + width > availableWidth) break
      used += gap + width
    }
    count += 1
  }
  return count
}
