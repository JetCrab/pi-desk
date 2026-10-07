export const L2_WORK_SESSION_EXPANDED_COLUMN_MIN_WIDTH = 300
export const L2_WORK_SESSION_COLLAPSED_COLUMN_WIDTH = 48

export type L2WorkSessionColumnMode = 'expanded' | 'collapsed'

function normalizeCount(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.floor(value))
}

export function calculateL2WorkSessionExpandedColumnCount(
  availableWidth: number,
  totalCount: number
): number {
  const normalizedTotalCount = normalizeCount(totalCount)
  if (normalizedTotalCount === 0) return 0

  const normalizedWidth = Number.isFinite(availableWidth)
    ? Math.max(0, Math.floor(availableWidth))
    : 0
  const collapsedBaseWidth = normalizedTotalCount * L2_WORK_SESSION_COLLAPSED_COLUMN_WIDTH
  const expandedWidthDelta =
    L2_WORK_SESSION_EXPANDED_COLUMN_MIN_WIDTH - L2_WORK_SESSION_COLLAPSED_COLUMN_WIDTH
  const capacity = Math.floor((normalizedWidth - collapsedBaseWidth) / expandedWidthDelta)

  return Math.min(normalizedTotalCount, Math.max(1, capacity))
}

export function calculateL2WorkSessionColumnModes(
  totalCount: number,
  expandedCount: number,
  protectedExpandedIndex: number | null
): L2WorkSessionColumnMode[] {
  const normalizedTotalCount = normalizeCount(totalCount)
  if (normalizedTotalCount === 0) return []

  const normalizedExpandedCount = Math.min(
    normalizedTotalCount,
    Math.max(1, normalizeCount(expandedCount))
  )
  const protectedIndex =
    protectedExpandedIndex !== null &&
    Number.isInteger(protectedExpandedIndex) &&
    protectedExpandedIndex >= 0 &&
    protectedExpandedIndex < normalizedTotalCount
      ? protectedExpandedIndex
      : null
  const modes = Array<L2WorkSessionColumnMode>(normalizedTotalCount).fill('expanded')
  let remainingCollapseCount = normalizedTotalCount - normalizedExpandedCount

  // 所有折叠都从最右侧开始；用户点击的位置只作为本轮扫描的跳过项。
  for (let index = normalizedTotalCount - 1; index >= 0 && remainingCollapseCount > 0; index -= 1) {
    if (index === protectedIndex) continue
    modes[index] = 'collapsed'
    remainingCollapseCount -= 1
  }

  return modes
}
