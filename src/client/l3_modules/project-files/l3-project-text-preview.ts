export function getL3ProjectTextPreviewKind(path: string): 'markdown' | 'html' | null {
  if (/\.(md|markdown)$/i.test(path)) return 'markdown'
  if (/\.html?$/i.test(path)) return 'html'
  return null
}
