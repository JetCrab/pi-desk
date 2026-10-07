export interface L2SidebarShortcutLayout {
  visibleApplicationCount: number
  rowItemCounts: number[]
}

export function calculateL2SidebarShortcutLayout(
  applicationCount: number,
  maxColumnCount: number,
  maxRows: number
): L2SidebarShortcutLayout {
  const capacity = maxColumnCount * maxRows
  const hasOverflow = applicationCount + 1 > capacity
  const visibleApplicationCount = hasOverflow ? Math.max(0, capacity - 2) : applicationCount
  const renderedItemCount = visibleApplicationCount + 1 + (hasOverflow ? 1 : 0)
  const rowCount = Math.ceil(renderedItemCount / maxColumnCount)
  const baseItemCount = Math.floor(renderedItemCount / rowCount)
  const fullerRowCount = renderedItemCount % rowCount

  return {
    visibleApplicationCount,
    rowItemCounts: Array.from(
      { length: rowCount },
      (_, rowIndex) => baseItemCount + (rowIndex < fullerRowCount ? 1 : 0)
    )
  }
}
