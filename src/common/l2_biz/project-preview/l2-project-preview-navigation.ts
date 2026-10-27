import type { L4Locale } from '@common/l4_foundation/locale/l4-locale'
import { L2_PROJECT_HISTORY_MESSAGES } from './l2-project-history-messages'

export const L2_PROJECT_PREVIEW_PATH = '/project-preview'

export function buildL2ProjectPreviewHref(cwd?: string | null): string {
  return cwd ? `${L2_PROJECT_PREVIEW_PATH}?cwd=${encodeURIComponent(cwd)}` : L2_PROJECT_PREVIEW_PATH
}

export function buildL2ProjectPreviewTitle(
  cwd: string | null | undefined,
  locale: L4Locale
): string {
  const directory = cwd?.trim() || null
  const name = directory?.replaceAll('\\', '/').split('/').filter(Boolean).at(-1) ?? directory
  return [name, L2_PROJECT_HISTORY_MESSAGES[locale].previewTitle, 'Pi Desk']
    .filter(Boolean)
    .join(' · ')
}
