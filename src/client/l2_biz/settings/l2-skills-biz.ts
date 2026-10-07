import { z } from 'zod'
import { L4ErrorTranslationSchema } from '@common/l4_foundation/locale/l4-error-translation'
import { l4LocalizedErrorMessage } from '@client/l4_foundation/locale/l4-localized-error'
import { saveL4CodePreferences } from '@client/l4_foundation/ui/code/l4-code-preferences'
import {
  L2SkillsContracts,
  type L2SkillsListRequest,
  type L2SkillsListResponse,
  type L2SkillFilesListRequest,
  type L2SkillFilesListResponse,
  type L2SkillFileGetRequest,
  type L2SkillFileGetResponse,
  type L2SkillFileReplaceRequest
} from '@common/l2_biz/settings/l2-skills-contract'

const EnvelopeSchema = z.object({
  code: z.number(),
  msg: z.string(),
  data: z.unknown(),
  i18n: L4ErrorTranslationSchema.optional()
})

async function request<I, O>(
  clientId: string,
  contract: { path: string; request: z.ZodType<I>; response: z.ZodType<O> },
  input: I,
  signal?: AbortSignal
): Promise<O> {
  const response = await fetch(contract.path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Pi-Desk-Client-Id': clientId },
    body: JSON.stringify(contract.request.parse(input)),
    signal
  })
  const envelope = EnvelopeSchema.parse(await response.json())
  if (!response.ok || envelope.code !== 0 || envelope.data === null)
    throw new Error(envelope.msg ? l4LocalizedErrorMessage(envelope) : 'Skills 请求失败')
  return contract.response.parse(envelope.data)
}

export interface L2SkillsBiz {
  list: (input: L2SkillsListRequest, signal?: AbortSignal) => Promise<L2SkillsListResponse>
  listFiles: (
    input: L2SkillFilesListRequest,
    signal?: AbortSignal
  ) => Promise<L2SkillFilesListResponse>
  getFile: (input: L2SkillFileGetRequest, signal?: AbortSignal) => Promise<L2SkillFileGetResponse>
  replaceFile: (input: L2SkillFileReplaceRequest) => Promise<void>
}

export function setL2SkillsWrapLines(wrapLines: boolean): void {
  saveL4CodePreferences({ wrapLines })
}

export async function copyL2SkillFilePath(target: L2SkillFileGetRequest): Promise<void> {
  const entry = target.skillPath.replaceAll('\\', '/')
  await navigator.clipboard.writeText(entry.slice(0, entry.lastIndexOf('/') + 1) + target.path)
}

export function createL2SkillsBiz(clientId: string): L2SkillsBiz {
  return {
    list: (input, signal) => request(clientId, L2SkillsContracts.list, input, signal),
    listFiles: (input, signal) => request(clientId, L2SkillsContracts.listFiles, input, signal),
    getFile: (input, signal) => request(clientId, L2SkillsContracts.getFile, input, signal),
    async replaceFile(input): Promise<void> {
      await request(clientId, L2SkillsContracts.replaceFile, input)
    }
  }
}
