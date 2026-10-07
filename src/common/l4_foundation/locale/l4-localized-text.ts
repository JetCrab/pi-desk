import { z } from 'zod'
import type { L4Locale } from './l4-locale'

export const L4LocalizedTextSchema = z.union([
  z.string(),
  z
    .object({
      default: z.string(),
      translations: z
        .record(z.string().min(1).max(35), z.string())
        .refine((translations) => Object.keys(translations).length <= 16, 'too many translations')
    })
    .strict()
])

export type L4LocalizedText = z.infer<typeof L4LocalizedTextSchema>

export function createL4BilingualText(chinese: string, english: string): L4LocalizedText {
  return { default: chinese, translations: { en: english } }
}

export function selectL4LocalizedText(text: L4LocalizedText, locale: L4Locale): string {
  if (typeof text === 'string') return text
  return text.translations[locale] ?? text.translations[locale.split('-')[0]!] ?? text.default
}
