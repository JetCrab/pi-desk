import type { L2WorkSessionListItem } from '@common/l2_biz/work-session/l2-work-session-contract'

export interface L2WorkbenchLayoutState {
  primaryWorkId: string | null
}

export const L2_WORKBENCH_LAYOUT_STORAGE_KEY = 'pi-super:workbench-layout'

export function findL2InvalidatedWorkSessionIds(
  previous: readonly L2WorkSessionListItem[],
  next: readonly L2WorkSessionListItem[]
): string[] {
  const nextByWorkId = new Map(next.map((workSession) => [workSession.workId, workSession]))
  return previous.flatMap((workSession) => {
    const current = nextByWorkId.get(workSession.workId)
    return !current ||
      current.cwd !== workSession.cwd ||
      current.sessionId !== workSession.sessionId
      ? [workSession.workId]
      : []
  })
}

export function reconcileL2WorkbenchLayout(
  state: L2WorkbenchLayoutState,
  workSessions: readonly L2WorkSessionListItem[],
  passiveInvalidatedWorkIds: readonly string[] = []
): L2WorkbenchLayoutState {
  const validWorkIds = new Set(workSessions.map((workSession) => workSession.workId))
  const invalidatedWorkIds = new Set(passiveInvalidatedWorkIds)
  const primaryWorkId =
    state.primaryWorkId &&
    validWorkIds.has(state.primaryWorkId) &&
    !invalidatedWorkIds.has(state.primaryWorkId)
      ? state.primaryWorkId
      : null
  return state.primaryWorkId === primaryWorkId ? state : { primaryWorkId }
}

export function getL2DisplayedWorkSessionIds(
  state: L2WorkbenchLayoutState,
  pinnedWorkIds: readonly string[]
): string[] {
  const workIds = state.primaryWorkId ? [state.primaryWorkId] : []
  workIds.push(...pinnedWorkIds)
  return Array.from(new Set(workIds))
}

export function parseL2WorkbenchLayout(value: string | null): L2WorkbenchLayoutState {
  if (!value) return { primaryWorkId: null }

  try {
    const parsed: unknown = JSON.parse(value)
    if (!parsed || typeof parsed !== 'object') return { primaryWorkId: null }
    const state = parsed as Partial<L2WorkbenchLayoutState>
    return {
      primaryWorkId: typeof state.primaryWorkId === 'string' ? state.primaryWorkId : null
    }
  } catch {
    return { primaryWorkId: null }
  }
}

export function loadL2WorkbenchLayout(): L2WorkbenchLayoutState {
  const saved = window.localStorage.getItem(L2_WORKBENCH_LAYOUT_STORAGE_KEY)
  return parseL2WorkbenchLayout(
    saved ?? window.sessionStorage.getItem(L2_WORKBENCH_LAYOUT_STORAGE_KEY)
  )
}

export function saveL2WorkbenchLayout(state: L2WorkbenchLayoutState): void {
  window.localStorage.setItem(L2_WORKBENCH_LAYOUT_STORAGE_KEY, JSON.stringify(state))
}
