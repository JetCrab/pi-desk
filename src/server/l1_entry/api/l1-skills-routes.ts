import 'server-only'

import { resolve } from 'node:path'
import type { z } from 'zod'
import { L2SkillsContracts } from '@common/l2_biz/settings/l2-skills-contract'
import { getL2WorkSessionManage } from '@server/l2_biz/work-session/l2-work-session-manage'
import {
  createL4ApiErrorResponse,
  createL4ApiSuccessResponse
} from '@server/l4_foundation/http/l4-api-response'
import {
  getL4SkillFile,
  listL4SkillFiles,
  listL4Skills,
  replaceL4SkillFile,
  L4SkillError
} from '@server/l4_foundation/skills/l4-skills'

function cwdKey(cwd: string): string {
  const value = resolve(cwd)
  return process.platform === 'win32' ? value.toLowerCase() : value
}

async function handle<T extends { cwd: string | null }, R>(
  request: Request,
  contract: { request: z.ZodType<T>; response: z.ZodType<R> },
  operation: (input: T) => Promise<R>
): Promise<Response> {
  let payload: unknown
  try {
    payload = await request.json()
  } catch {
    return createL4ApiErrorResponse(400, 'Skills 请求 JSON 格式无效', { key: 'errors:invalidJson' })
  }
  const input = contract.request.safeParse(payload)
  if (!input.success) {
    const tooLarge = input.error.issues.some(
      (issue) => issue.code === 'too_big' && issue.path[0] === 'content'
    )
    return createL4ApiErrorResponse(
      tooLarge ? 413 : 400,
      tooLarge ? '提交文本超过大小限制' : 'Skills 请求参数无效',
      { key: tooLarge ? 'errors:skillsContentTooLarge' : 'errors:skillsInputInvalid' }
    )
  }
  try {
    if (input.data.cwd !== null) {
      const key = cwdKey(input.data.cwd)
      const snapshot = await getL2WorkSessionManage().listWorkSessions()
      const project = snapshot.workSessions.find((item) => cwdKey(item.cwd) === key)
      if (!project)
        return createL4ApiErrorResponse(409, '此项目已不在当前工作区，请重新选择项目', {
          key: 'errors:skillsProjectChanged'
        })
      input.data.cwd = project.cwd
    }
    return createL4ApiSuccessResponse(contract.response.parse(await operation(input.data)))
  } catch (error) {
    if (error instanceof L4SkillError) return createL4ApiErrorResponse(error.status, error.message)
    if (error && typeof error === 'object' && 'code' in error) {
      if (error.code === 'ENOENT')
        return createL4ApiErrorResponse(404, 'Skill 或文件已不存在', { key: 'errors:skillMissing' })
      if (error.code === 'EPERM' || error.code === 'EACCES')
        return createL4ApiErrorResponse(403, '没有权限读写此 Skill 文件', {
          key: 'errors:skillsPermissionDenied'
        })
    }
    console.error('[Pi Desk][SkillsApi] Skills 操作失败', error)
    return createL4ApiErrorResponse(500, 'Skills 文件操作失败，请重试', {
      key: 'errors:skillsFileFailed'
    })
  }
}

export async function listSkillsPOST(request: Request): Promise<Response> {
  return handle(request, L2SkillsContracts.list, (input) => listL4Skills(input.cwd))
}
export async function listSkillFilesPOST(request: Request): Promise<Response> {
  return handle(request, L2SkillsContracts.listFiles, (input) =>
    listL4SkillFiles(input.cwd, input.skillPath, input.path)
  )
}
export async function getSkillFilePOST(request: Request): Promise<Response> {
  return handle(request, L2SkillsContracts.getFile, (input) =>
    getL4SkillFile(input.cwd, input.skillPath, input.path)
  )
}
export async function replaceSkillFilePOST(request: Request): Promise<Response> {
  return handle(request, L2SkillsContracts.replaceFile, async (input) => {
    await replaceL4SkillFile(input.cwd, input.skillPath, input.path, input.content)
    return {}
  })
}
