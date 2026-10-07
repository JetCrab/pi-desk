import 'server-only'
import { isAbsolute } from 'node:path'
import type { z } from 'zod'
import * as contracts from '@common/l3_modules/project-files/l3-project-files-contract'
import { getL2WorkSessionManage } from '@server/l2_biz/work-session/l2-work-session-manage'
import {
  createL4ApiErrorResponse,
  createL4ApiSuccessResponse
} from '@server/l4_foundation/http/l4-api-response'
import { getL4WorkSessionGitErrorKind } from '@server/l4_foundation/git/l4-work-session-git'
import { createL1WorkSessionFileErrorResponse } from './l1-work-session-file-error'
import { createL1WorkSessionGitErrorResponse } from './l1-work-session-git-error'

export function createL1ProjectRoute<I extends contracts.L3ProjectReadContext, O>(
  contract: { path: string; request: z.ZodType<I>; response: z.ZodType<O> },
  execute: (input: I) => Promise<O>
): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    let payload: unknown
    try {
      payload = await request.json()
    } catch {
      return createL4ApiErrorResponse(400, '项目请求 JSON 格式无效', {
        key: 'errors:projectJsonInvalid'
      })
    }
    const parsed = contract.request.safeParse(payload)
    if (!parsed.success)
      return createL4ApiErrorResponse(400, '项目请求参数无效', {
        key: 'errors:projectInputInvalid'
      })
    const input = parsed.data
    if (!isAbsolute(input.cwd) || input.cwd.includes('\0'))
      return createL4ApiErrorResponse(400, '项目目录必须是绝对路径', {
        key: 'errors:projectCwdAbsolute'
      })
    try {
      if (input.workId) {
        const session = await getL2WorkSessionManage().getWorkSession(input.workId)
        if (!session)
          return createL4ApiErrorResponse(404, '工作会话不存在', { key: 'errors:sessionMissing' })
        if (session.cwd !== input.cwd)
          return createL4ApiErrorResponse(409, '工作会话项目已变化', {
            key: 'errors:projectChanged'
          })
        input.cwd = session.cwd
      }
      return createL4ApiSuccessResponse(contract.response.parse(await execute(input)))
    } catch (error) {
      console.warn('[Pi Desk][Project] 项目请求失败', {
        path: contract.path,
        cwd: input.cwd,
        workId: input.workId,
        error: error instanceof Error ? error.message : String(error)
      })
      if (getL4WorkSessionGitErrorKind(error) === 'read-failed') {
        return createL4ApiErrorResponse(
          500,
          error instanceof Error ? error.message : '读取 Git 失败',
          error instanceof Error ? undefined : { key: 'errors:gitReadOperationFailed' }
        )
      }
      return (
        createL1WorkSessionFileErrorResponse(error) ??
        createL1WorkSessionGitErrorResponse(error) ??
        createL4ApiErrorResponse(500, '项目操作失败', { key: 'errors:projectOperationFailed' })
      )
    }
  }
}
