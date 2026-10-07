import 'server-only'

import { L2WorkSessionGitBranchReplaceRequestSchema } from '@common/l2_biz/work-session/l2-work-session-git-contract'
import { getL2WorkSessionManage } from '@server/l2_biz/work-session/l2-work-session-manage'
import {
  createL4ApiErrorResponse,
  createL4ApiSuccessResponse
} from '@server/l4_foundation/http/l4-api-response'
import { createL1WorkSessionGitErrorResponse } from './l1-work-session-git-error'

export async function POST(request: Request): Promise<Response> {
  let payload: unknown
  try {
    payload = await request.json()
  } catch {
    return createL4ApiErrorResponse(400, 'Git 分支切换请求 JSON 格式无效', {
      key: 'errors:gitSwitchJsonInvalid'
    })
  }

  const input = L2WorkSessionGitBranchReplaceRequestSchema.safeParse(payload)
  if (!input.success)
    return createL4ApiErrorResponse(400, 'Git 分支切换请求参数无效', {
      key: 'errors:gitSwitchInputInvalid'
    })

  try {
    return createL4ApiSuccessResponse(
      await getL2WorkSessionManage().replaceProjectGitBranch(input.data)
    )
  } catch (error) {
    const response = createL1WorkSessionGitErrorResponse(error)
    if (response) return response
    console.error('[Pi Desk][WorkSessionGitBranchReplaceApi] 切换 Git 分支失败', {
      workId: input.data.workId,
      cwd: input.data.cwd,
      repositoryRoot: input.data.repositoryRoot,
      targetType: input.data.target.type,
      targetName: input.data.target.name,
      errorName: error instanceof Error ? error.name : 'UnknownError'
    })
    return createL4ApiErrorResponse(500, '切换 Git 分支失败', { key: 'errors:gitSwitchFailed' })
  }
}
