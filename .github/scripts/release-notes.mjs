const categories = ['breaking', 'features', 'added', 'changed', 'fixed', 'removed']
const headings = ['Breaking Changes', 'New Features', 'Added', 'Changed', 'Fixed', 'Removed']

function failure(category) {
  return new Error(`发布说明错误：${category}`)
}

export function validateChanges(changes) {
  if (
    changes === null ||
    typeof changes !== 'object' ||
    Array.isArray(changes) ||
    Object.keys(changes).length !== categories.length ||
    !categories.every((key) => Object.hasOwn(changes, key))
  ) {
    throw failure('INVALID_CHANGES')
  }
  for (const key of categories) {
    if (
      !Array.isArray(changes[key]) ||
      changes[key].some(
        (text) =>
          typeof text !== 'string' ||
          !text.trim() ||
          text.length > 2000 ||
          /[\u0000-\u001f\u007f]/u.test(text)
      )
    ) {
      throw failure('INVALID_CHANGES')
    }
  }
  return changes
}

function markdownText(value) {
  if (typeof value !== 'string' || !value.trim() || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw failure('INVALID_RECORD')
  }
  return value.replace(/[\\`*_{}\[\]()<>|]/gu, '\\$&')
}

function encodeSegment(value) {
  return encodeURIComponent(value).replace(
    /[!'()*]/gu,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  )
}

export function renderReleaseNotes(record, { repository }) {
  const changes = validateChanges(record.changes)
  if (
    typeof repository !== 'string' ||
    repository.split('/').length !== 2 ||
    repository.split('/').some((part) => !part || part === '.' || part === '..') ||
    typeof record.tag !== 'string' ||
    !record.tag ||
    !Array.isArray(record.packages) ||
    !Array.isArray(record.clients)
  ) {
    throw failure('INVALID_RECORD')
  }
  const downloadRoot = `https://github.com/${repository.split('/').map(encodeSegment).join('/')}/releases/download/${encodeSegment(record.tag)}`
  const version = record.packages.find((item) => item.name === '@jetcrab/pi-desk')?.version
  const lines = [
    `## Pi Desk${version ? ` ${markdownText(version)}` : ' 更新'}`,
    '',
    `[发布记录](https://github.com/${repository.split('/').map(encodeSegment).join('/')}/releases/tag/${encodeSegment(record.tag)})`,
    ''
  ]
  categories.forEach((key, index) => {
    if (!changes[key].length) return
    lines.push(
      `### ${headings[index]}`,
      '',
      ...changes[key].map((text) => `- ${markdownText(text)}`),
      ''
    )
  })
  const labels = { windows: 'Windows', macos: 'macOS', android: 'Android' }
  const components = record.packages.map(({ name, version }) => [name, version])
  for (const client of record.clients) {
    if (
      !Object.hasOwn(labels, client.platform) ||
      typeof client.file !== 'string' ||
      !client.file
    ) {
      throw failure('INVALID_RECORD')
    }
    components.push([labels[client.platform], client.version])
  }
  if (components.length) {
    lines.push(
      '### 组件版本',
      '',
      '| 组件 | 版本 |',
      '| --- | --- |',
      ...components.map(
        ([name, version]) => `| ${markdownText(name)} | ${markdownText(version)} |`
      ),
      ''
    )
  }
  if (record.clients.length) {
    lines.push(
      '### 下载',
      '',
      ...record.clients.map((client) => {
        let note = ''
        if (client.platform === 'macos') {
          const signing = client.file.endsWith('-adhoc.dmg')
            ? '临时签名，未公证'
            : client.file.endsWith('-developer-id.dmg')
              ? 'Developer ID 签名，未公证'
              : '未公证'
          note = `（${signing}）`
        }
        return `- [${labels[client.platform]} ${markdownText(client.version)}](${downloadRoot}/${encodeSegment(client.file)})${note}`
      }),
      ''
    )
  }
  return lines.join('\n')
}
