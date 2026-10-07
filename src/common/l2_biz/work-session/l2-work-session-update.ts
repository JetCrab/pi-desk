import {
  L2WorkSessionListItemSchema,
  L2WorkSessionListResponseSchema,
  type L2WorkSessionListResponse
} from './l2-work-session-contract'
import type { L2WorkSessionsUpdate } from './l2-work-session-realtime-contract'

export function applyL2WorkSessionsUpdate(
  current: L2WorkSessionListResponse,
  update: L2WorkSessionsUpdate
): L2WorkSessionListResponse {
  if (update.type === 'snapshot') {
    return L2WorkSessionListResponseSchema.parse({
      workSessions: update.workSessions,
      pinnedCount: update.pinnedCount
    })
  }

  const index = current.workSessions.findIndex(
    (workSession) => workSession.workId === update.workId
  )
  if (index < 0) {
    // 删除可能在 HTTP 快照和 WebSocket 增量中各到达一次，重复删除保持终态即可。
    if (update.type === 'delete') return current
    throw new Error(`WorkSession update target was not found: ${update.workId}`)
  }

  if (update.type === 'delete') {
    return {
      workSessions: current.workSessions.filter(
        (workSession) => workSession.workId !== update.workId
      ),
      pinnedCount: current.pinnedCount - Number(index < current.pinnedCount)
    }
  }

  const workSessions = [...current.workSessions]
  workSessions[index] = L2WorkSessionListItemSchema.parse({
    ...current.workSessions[index],
    ...update.changes
  })
  return {
    workSessions,
    pinnedCount: current.pinnedCount
  }
}
