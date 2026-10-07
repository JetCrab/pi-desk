import 'server-only'

export function decodeGitDiffText(value: Buffer): string | null {
  if (value.includes(0)) return null
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(value)
  } catch {
    return null
  }
}
