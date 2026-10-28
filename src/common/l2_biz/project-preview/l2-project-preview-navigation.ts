export const L2_PROJECT_PREVIEW_PATH = '/project-preview'

export function buildL2ProjectPreviewHref(cwd?: string | null): string {
  return cwd ? `${L2_PROJECT_PREVIEW_PATH}?cwd=${encodeURIComponent(cwd)}` : L2_PROJECT_PREVIEW_PATH
}

export function buildL2ProjectPreviewTitle(cwd: string | null | undefined): string {
  const directory = cwd?.trim()
  if (!directory) return 'Pi Desk'
  const name = directory.replaceAll('\\', '/').split('/').filter(Boolean).at(-1) ?? directory
  return name === directory ? directory : `${name} – ${directory}`
}
