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
  const lines = []
  categories.forEach((key, index) => {
    if (!changes[key].length) return
    lines.push(
      `### ${headings[index]}`,
      '',
      ...changes[key].map((text) => `- ${markdownText(text)}`),
      ''
    )
  })
  for (const client of record.clients) {
    if (
      !['windows', 'macos', 'android'].includes(client.platform) ||
      typeof client.file !== 'string' ||
      !client.file
    ) {
      throw failure('INVALID_RECORD')
    }
  }
  if (record.clients.some((client) => client.platform === 'macos')) {
    lines.push('### Notes', '', 'The macOS build is experimental and not notarized.', '')
  }
  return lines.join('\n')
}
