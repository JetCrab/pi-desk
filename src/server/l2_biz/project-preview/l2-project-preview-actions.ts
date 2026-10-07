import 'server-only'
import type { z } from 'zod'
import type { L3ProjectFileReveal } from '@common/l3_modules/project-files/l3-project-files-contract'
import { revealL4WorkSessionProjectFile } from '@server/l4_foundation/file/l4-work-session-project-file'

export async function revealL2ProjectPath(
  input: z.output<typeof L3ProjectFileReveal.request>
): Promise<z.output<typeof L3ProjectFileReveal.response>> {
  await revealL4WorkSessionProjectFile(input.cwd, input.path, undefined, input.targetType)
  console.info('[Pi Desk][Project] 已请求系统文件管理器定位', {
    cwd: input.cwd,
    path: input.path,
    targetType: input.targetType ?? 'file',
    workId: input.workId
  })
  return {}
}
