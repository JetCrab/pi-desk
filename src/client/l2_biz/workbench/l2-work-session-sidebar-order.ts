export const L2_WORK_SESSION_PIN_BOUNDARY_ID = 'work-session-pin:boundary'

export interface L2WorkSessionArrangement {
  workIds: string[]
  pinnedCount: number
}

export function getL2WorkSessionVisualSortableIds(
  workIds: readonly string[],
  pinnedCount: number
): string[] {
  assertPinnedCount(workIds, pinnedCount)
  const pinned = workIds.slice(0, pinnedCount)
  const others = workIds.slice(pinnedCount)
  return pinned.length > 0 && others.length > 0
    ? [...others, L2_WORK_SESSION_PIN_BOUNDARY_ID, ...pinned]
    : [...others, ...pinned]
}

export function toggleL2WorkSessionPinned(
  workIds: readonly string[],
  pinnedCount: number,
  workId: string
): L2WorkSessionArrangement | null {
  assertPinnedCount(workIds, pinnedCount)
  const index = workIds.indexOf(workId)
  if (index < 0) return null

  const nextWorkIds = workIds.filter((id) => id !== workId)
  const pinned = index < pinnedCount
  const nextPinnedCount = pinned ? pinnedCount - 1 : pinnedCount + 1
  nextWorkIds.splice(pinned ? nextWorkIds.length : pinnedCount, 0, workId)
  return { workIds: nextWorkIds, pinnedCount: nextPinnedCount }
}

export function pinL2CreatedWorkSession(
  workIds: readonly string[],
  pinnedCount: number,
  workId: string
): L2WorkSessionArrangement | null {
  assertPinnedCount(workIds, pinnedCount)
  const index = workIds.indexOf(workId)
  if (index >= 0 && index < pinnedCount) return null

  const nextWorkIds = workIds.filter((id) => id !== workId)
  nextWorkIds.splice(pinnedCount, 0, workId)
  return { workIds: nextWorkIds, pinnedCount: pinnedCount + 1 }
}

export function moveL2WorkSessionVisual(
  workIds: readonly string[],
  pinnedCount: number,
  activeId: string,
  overId: string
): L2WorkSessionArrangement | null {
  assertPinnedCount(workIds, pinnedCount)
  if (activeId === overId || activeId === L2_WORK_SESSION_PIN_BOUNDARY_ID) return null

  const sortableIds = getL2WorkSessionVisualSortableIds(workIds, pinnedCount)
  const activeIndex = sortableIds.indexOf(activeId)
  const overIndex = sortableIds.indexOf(overId)
  if (activeIndex < 0 || overIndex < 0) return null

  const boundaryIndex = sortableIds.indexOf(L2_WORK_SESSION_PIN_BOUNDARY_ID)
  if (boundaryIndex < 0) {
    const nextWorkIds = moveItem(sortableIds, activeIndex, overIndex)
    return { workIds: nextWorkIds, pinnedCount }
  }

  const activeWasPinned = workIds.indexOf(activeId) < pinnedCount
  const nextSortableIds =
    overId === L2_WORK_SESSION_PIN_BOUNDARY_ID
      ? moveAroundBoundary(sortableIds, activeIndex, activeWasPinned)
      : moveItem(sortableIds, activeIndex, overIndex)
  const nextBoundaryIndex = nextSortableIds.indexOf(L2_WORK_SESSION_PIN_BOUNDARY_ID)
  if (nextBoundaryIndex < 0) return null
  const others = nextSortableIds.slice(0, nextBoundaryIndex)
  const pinned = nextSortableIds.slice(nextBoundaryIndex + 1)
  const nextWorkIds = [...pinned, ...others]
  if (nextWorkIds.length !== workIds.length || new Set(nextWorkIds).size !== workIds.length) {
    return null
  }
  return { workIds: nextWorkIds, pinnedCount: pinned.length }
}

function moveAroundBoundary(
  values: readonly string[],
  fromIndex: number,
  activeWasPinned: boolean
): string[] {
  const next = [...values]
  const [value] = next.splice(fromIndex, 1)
  if (!value) return next
  const boundaryIndex = next.indexOf(L2_WORK_SESSION_PIN_BOUNDARY_ID)
  if (boundaryIndex < 0) return [...values]
  next.splice(activeWasPinned ? boundaryIndex : boundaryIndex + 1, 0, value)
  return next
}

function moveItem(values: readonly string[], fromIndex: number, toIndex: number): string[] {
  const next = [...values]
  const [value] = next.splice(fromIndex, 1)
  if (!value) return next
  next.splice(toIndex, 0, value)
  return next
}

function assertPinnedCount(workIds: readonly string[], pinnedCount: number): void {
  if (!Number.isInteger(pinnedCount) || pinnedCount < 0 || pinnedCount > workIds.length) {
    throw new Error('Invalid work session pinnedCount')
  }
}
