import assert from 'node:assert/strict'

function unquote(value) {
  return value.replace(/^(['"])(.*)\1$/, '$2')
}

// 发布只需要 pnpm v9 的 importer、package 和 snapshot 块，不解释任意 YAML。
function lockBlocks(text) {
  assert.match(text, /^lockfileVersion: ['"]?9\.0['"]?$/m, '只支持当前 pnpm v9 锁文件')
  const sections = new Map()
  let section
  let key
  for (const line of text.split(/\r?\n/)) {
    const top = /^([\w-]+):(?:\s.*)?$/.exec(line)
    if (top) {
      section = top[1]
      sections.set(section, new Map())
      key = undefined
    } else if (section === 'settings' || section === 'overrides') {
      if (line.trim() && !line.trimStart().startsWith('#')) {
        const blocks = sections.get(section)
        blocks.set('', `${blocks.get('') ?? ''}${line}\n`)
      }
    } else {
      const header = /^ {2}(\S.*?):(?: \{\})?$/.exec(line)
      if (header && section) {
        key = unquote(header[1])
        sections.get(section).set(key, line.endsWith('{}') ? '{}' : '')
      } else if (key && line.trim() && !line.trimStart().startsWith('#')) {
        const blocks = sections.get(section)
        blocks.set(key, `${blocks.get(key)}${line}\n`)
      }
    }
  }
  return sections
}

export function lockDependencyContent(text, importer) {
  if (text === null) return null
  const sections = lockBlocks(text)
  const imported = sections.get('importers')?.get(importer)
  if (imported === undefined) return null
  const snapshots = sections.get('snapshots') ?? new Map()
  const packages = sections.get('packages') ?? new Map()
  const pending = []
  let name
  for (const line of imported.split('\n')) {
    const dependency = /^ {6}(\S.*?):$/.exec(line)
    if (dependency) name = unquote(dependency[1])
    const version = /^ {8}version: (.+)$/.exec(line)
    if (version && name && !/^(?:link:|file:)/.test(unquote(version[1]))) {
      pending.push(`${name}@${unquote(version[1])}`)
    }
  }
  const visited = new Map()
  while (pending.length) {
    const id = pending.pop()
    if (visited.has(id)) continue
    const content = snapshots.get(id) ?? ''
    visited.set(id, [content, packages.get(id.split('(')[0]) ?? ''])
    for (const line of content.split('\n')) {
      const dependency = /^ {6}(\S.*?): (.+)$/.exec(line)
      if (dependency && !/^(?:link:|file:)/.test(unquote(dependency[2]))) {
        pending.push(`${unquote(dependency[1])}@${unquote(dependency[2])}`)
      }
    }
  }
  return {
    imported,
    dependencies: [...visited].sort(([left], [right]) => left.localeCompare(right)),
    settings: [...(sections.get('settings') ?? [])],
    overrides: [...(sections.get('overrides') ?? [])]
  }
}
