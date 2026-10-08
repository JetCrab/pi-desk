import 'server-only'

export function createHeadingIdGenerator(): (text: string) => string {
  const ids = new Map<string, number>()
  return (text: string): string => {
    const base =
      text
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s-]/gu, '')
        .trim()
        .replace(/\s+/g, '-') || 'section'
    const count = ids.get(base) ?? 0
    ids.set(base, count + 1)
    return count ? `${base}-${count}` : base
  }
}
