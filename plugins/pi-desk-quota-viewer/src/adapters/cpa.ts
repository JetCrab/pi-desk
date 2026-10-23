import { z } from 'zod'
import { stringValue } from './resources.js'

export const cpaConfigSchema = z
  .object({
    managementUrl: z.string().trim().url('Management URL 必须是有效 URL'),
    managementKey: z.string().trim().min(1, 'Management Key 不能为空')
  })
  .strict()

export function managementBaseUrl(value: string): string {
  const url = new URL(value)
  url.search = ''
  url.hash = ''
  const path = url.pathname.replace(/\/+$/, '')
  url.pathname = path.endsWith('/v0/management') ? path : `${path}/v0/management`
  return url.toString().replace(/\/$/, '')
}

export function accountDisplay(file: Record<string, unknown>, fallback: string): string {
  return stringValue(file.email) ?? stringValue(file.account) ?? stringValue(file.name) ?? fallback
}
