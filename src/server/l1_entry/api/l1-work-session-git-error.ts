import 'server-only'

import { getL4WorkSessionGitErrorKind } from '@server/l4_foundation/git/l4-work-session-git'
import { createL4ApiErrorResponse } from '@server/l4_foundation/http/l4-api-response'

export function createL1WorkSessionGitErrorResponse(error: unknown): Response | null {
  if (error instanceof Error && error.name === 'WorkSessionNotFoundError') {
    return createL4ApiErrorResponse(404, '工作会话不存在', { key: 'errors:sessionMissing' })
  }
  if (error instanceof Error && error.name === 'WorkSessionProjectChangedError') {
    return createL4ApiErrorResponse(409, '工作会话项目已变化', { key: 'errors:projectChanged' })
  }

  switch (getL4WorkSessionGitErrorKind(error)) {
    case 'project-not-found':
      return createL4ApiErrorResponse(404, '项目目录不存在', { key: 'errors:projectMissing' })
    case 'not-repository':
      return createL4ApiErrorResponse(404, 'Git 仓库不存在', { key: 'errors:repositoryMissing' })
    case 'outside-project':
      return createL4ApiErrorResponse(403, 'Git 目标不在当前项目目录内', {
        key: 'errors:gitOutsideProject'
      })
    case 'invalid-ref':
      return createL4ApiErrorResponse(400, error instanceof Error ? error.message : 'Git 分支无效')
    case 'scan-limit':
      return createL4ApiErrorResponse(413, error instanceof Error ? error.message : 'Git 仓库过大')
    case 'operation-failed':
      return createL4ApiErrorResponse(409, error instanceof Error ? error.message : 'Git 操作失败')
    case 'read-failed':
      return createL4ApiErrorResponse(500, '读取 Git 仓库失败', { key: 'errors:gitReadFailed' })
    case null:
      return null
  }
}
