function hasControlCharacters(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0)
    return code <= 0x1f || (code >= 0x7f && code <= 0x9f)
  })
}

export function L2ResolveAuthReturnTo(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value.startsWith('/') ||
    value.startsWith('//') ||
    value.includes('\\') ||
    hasControlCharacters(value)
  ) {
    return '/'
  }

  let pathname: string
  try {
    pathname = decodeURIComponent(value.split(/[?#]/, 1)[0])
    if (hasControlCharacters(decodeURIComponent(value))) return '/'
  } catch {
    return '/'
  }
  if (pathname.startsWith('//') || pathname.includes('\\')) return '/'

  const segments: string[] = []
  for (const segment of pathname.split('/')) {
    if (segment === '..') segments.pop()
    else if (segment !== '' && segment !== '.') segments.push(segment)
  }
  if (segments.join('/').toLowerCase() === 'login') return '/'

  return value
}

export function L2BuildLoginHref(returnTo: unknown): string {
  const target = L2ResolveAuthReturnTo(returnTo)
  return target === '/' ? '/login' : `/login?returnTo=${encodeURIComponent(target)}`
}
