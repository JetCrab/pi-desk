export type L3ConversationIncrementRoot = 'summary' | 'detail'
export type L3ConversationIncrementSegment = string | number

export interface L3ConversationIncrementPath {
  root: L3ConversationIncrementRoot
  segments: readonly L3ConversationIncrementSegment[]
}

function parseSegment(value: string): L3ConversationIncrementSegment {
  if (!/^(0|[1-9]\d*)$/.test(value)) return value
  const index = Number(value)
  if (!Number.isSafeInteger(index)) throw new Error(`Increment array index is invalid: ${value}`)
  return index
}

export function parseL3ConversationIncrementPath(value: string): L3ConversationIncrementPath {
  if (!value || value.length > 1024) throw new Error('Increment path length is invalid')
  const rawSegments: string[] = []
  let current = ''
  let escaping = false

  for (const character of value) {
    if (escaping) {
      if (character !== '.' && character !== '\\') {
        throw new Error(`Increment path contains an invalid escape: \\${character}`)
      }
      current += character
      escaping = false
      continue
    }
    if (character === '\\') {
      escaping = true
      continue
    }
    if (character === '.') {
      if (!current) throw new Error('Increment path contains an empty segment')
      rawSegments.push(current)
      current = ''
      continue
    }
    current += character
  }

  if (escaping) throw new Error('Increment path ends with an escape')
  if (!current) throw new Error('Increment path contains an empty segment')
  rawSegments.push(current)
  const root = rawSegments.shift()
  if (root !== 'summary' && root !== 'detail') {
    throw new Error('Increment path root must be summary or detail')
  }
  return { root, segments: rawSegments.map(parseSegment) }
}

export function isL3ConversationIncrementPathPrefix(
  parent: L3ConversationIncrementPath,
  child: L3ConversationIncrementPath
): boolean {
  if (parent.root !== child.root || parent.segments.length > child.segments.length) return false
  return parent.segments.every((segment, index) => segment === child.segments[index])
}
