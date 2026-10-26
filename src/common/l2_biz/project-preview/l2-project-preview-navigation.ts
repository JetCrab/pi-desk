export const L2_PROJECT_PREVIEW_PATH = '/project-preview'

export function buildL2ProjectPreviewHref(cwd?: string | null): string {
  return cwd ? `${L2_PROJECT_PREVIEW_PATH}?cwd=${encodeURIComponent(cwd)}` : L2_PROJECT_PREVIEW_PATH
}
