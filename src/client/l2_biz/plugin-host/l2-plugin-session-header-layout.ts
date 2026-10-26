export function calculateL2PluginSessionHeaderInlineCount(
  widths: readonly number[],
  availableWidth: number,
  moreWidth: number,
  gap: number
): number {
  const total = widths.reduce((sum, width) => sum + width, 0) + Math.max(0, widths.length - 1) * gap
  if (total <= availableWidth) return widths.length

  let used = moreWidth
  let count = 0
  for (const width of widths) {
    if (used + gap + width > availableWidth) break
    used += gap + width
    count += 1
  }
  return count
}
