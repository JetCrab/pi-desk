import { z } from 'zod'
import type { L4LocalizedText } from '@common/l4_foundation/locale/l4-localized-text'

export const L4PluginUpdateTagSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z][a-zA-Z0-9._-]*$/)

export const L4PluginRegistrySchema = z
  .string()
  .trim()
  .url()
  .max(2048)
  .refine((value) => {
    const url = new URL(value)
    return (
      ['https:', 'http:'].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    )
  }, '插件源必须是 HTTP 或 HTTPS 仓库地址')
export const L4PluginDownloadSourceSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('auto') }).strict(),
  z.object({ mode: z.literal('local') }).strict(),
  z.object({ mode: z.literal('official') }).strict(),
  z.object({ mode: z.literal('domestic') }).strict(),
  z.object({ mode: z.literal('custom'), registry: L4PluginRegistrySchema }).strict()
])
export type L4PluginDownloadSource = z.infer<typeof L4PluginDownloadSourceSchema>

const PackageTranslationSchema = z.object({
  description: z.string().trim().min(1).max(4000).optional(),
  readme: z.string().trim().min(1).max(1024).optional()
})
const PackageMetadataSchema = z
  .object({
    description: z.string().optional(),
    piDesk: z
      .object({
        i18n: z.record(z.string().min(1).max(35), PackageTranslationSchema).optional()
      })
      .passthrough()
      .optional()
  })
  .passthrough()

export function readL4PluginDescription(manifest: unknown): L4LocalizedText | null {
  const parsed = PackageMetadataSchema.safeParse(manifest)
  if (!parsed.success) return null
  const description = parsed.data.description?.trim()
  if (!description) return null
  const translations = Object.fromEntries(
    Object.entries(parsed.data.piDesk?.i18n ?? {})
      .slice(0, 16)
      .flatMap(([locale, text]) => (text.description ? [[locale, text.description]] : []))
  )
  return Object.keys(translations).length ? { default: description, translations } : description
}

export function l4PluginSourceIdentity(source: string): string {
  const match = /^npm:((?:@[^/]+\/)?[^@]+)(?:@.+)?$/.exec(source)
  return match ? `npm:${match[1]}` : source.replaceAll('\\', '/')
}

export function l4PluginNpmName(source: string): string | null {
  return /^npm:((?:@[^/]+\/)?[^@]+)(?:@.+)?$/.exec(source)?.[1] ?? null
}

export function isL4PluginNewerVersion(candidate: string, current: string): boolean {
  const pattern = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/
  const next = pattern.exec(candidate)
  const previous = pattern.exec(current)
  if (!next || !previous) return false
  for (let index = 1; index <= 3; index++) {
    const difference = Number(next[index]) - Number(previous[index])
    if (difference) return difference > 0
  }
  if (!next[4] || !previous[4]) return !next[4] && Boolean(previous[4])
  const left = next[4].split('.')
  const right = previous[4].split('.')
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const a = left[index]
    const b = right[index]
    if (a === b) continue
    if (a === undefined || b === undefined) return b === undefined
    const numericA = /^\d+$/.test(a)
    const numericB = /^\d+$/.test(b)
    if (numericA && numericB) return Number(a) > Number(b)
    if (numericA !== numericB) return numericB
    return a > b
  }
  return false
}
