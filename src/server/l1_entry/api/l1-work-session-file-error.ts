import 'server-only'

import { getL4WorkSessionProjectFileErrorKind } from '@server/l4_foundation/file/l4-work-session-project-file'
import { L4ProjectSearchError } from '@server/l4_foundation/file/l4-project-search'
import { createL4ApiErrorResponse } from '@server/l4_foundation/http/l4-api-response'

export function createL1WorkSessionFileErrorResponse(error: unknown): Response | null {
  if (error instanceof Error && error.name === 'WorkSessionNotFoundError') {
    return createL4ApiErrorResponse(404, '工作会话不存在', { key: 'errors:sessionMissing' })
  }
  if (error instanceof Error && error.name === 'WorkSessionProjectChangedError') {
    return createL4ApiErrorResponse(409, '工作会话项目已变化', { key: 'errors:projectChanged' })
  }

  if (error instanceof Error && error.name === 'AbortError') {
    return createL4ApiErrorResponse(499, '项目搜索已取消', { key: 'errors:projectSearchCancelled' })
  }
  if (error instanceof L4ProjectSearchError) {
    switch (error.kind) {
      case 'invalid-pattern':
        return createL4ApiErrorResponse(400, error.message, {
          key: 'errors:projectSearchPatternInvalid'
        })
      case 'unavailable':
        return createL4ApiErrorResponse(503, error.message, {
          key: 'errors:projectSearchUnavailable'
        })
      case 'timeout':
        return createL4ApiErrorResponse(504, error.message, { key: 'errors:projectSearchTimeout' })
      case 'read-failed':
        return createL4ApiErrorResponse(500, error.message, {
          key: 'errors:projectSearchReadFailed'
        })
    }
  }

  switch (getL4WorkSessionProjectFileErrorKind(error)) {
    case 'not-found':
      return createL4ApiErrorResponse(404, '文件或目录不存在', { key: 'errors:fileMissing' })
    case 'not-directory':
      return createL4ApiErrorResponse(400, '目标不是目录', { key: 'errors:notDirectory' })
    case 'not-file':
      return createL4ApiErrorResponse(400, '目标不是文件', { key: 'errors:notFile' })
    case 'outside-project':
      return createL4ApiErrorResponse(403, '目标不在当前项目目录内', {
        key: 'errors:outsideProject'
      })
    case 'text-too-large':
      return createL4ApiErrorResponse(413, '文本文件超过 5MB，暂不支持在线预览', {
        key: 'errors:textTooLarge'
      })
    case 'image-too-large':
      return createL4ApiErrorResponse(413, '图片过大，暂不支持在线预览', {
        key: 'errors:imageTooLarge'
      })
    case 'unsupported':
      return createL4ApiErrorResponse(415, '当前文件类型不支持在线预览', {
        key: 'errors:previewUnsupported'
      })
    case 'read-failed':
      return createL4ApiErrorResponse(500, '读取项目文件失败', { key: 'errors:fileReadFailed' })
    case 'reveal-failed':
      return createL4ApiErrorResponse(500, '打开所在文件夹失败', { key: 'errors:revealFailed' })
    case null:
      return null
  }
}
