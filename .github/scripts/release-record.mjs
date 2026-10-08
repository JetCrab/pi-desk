import assert from 'node:assert/strict'

export const changeSections = ['breaking', 'features', 'added', 'changed', 'fixed', 'removed']
export const clientPlatforms = ['windows', 'macos', 'android']
export const releaseTagPattern = /^v\d+\.\d+\.\d+$/

export function clientFilename(platform) {
  const files = {
    windows: 'PiDesk-Windows-x86-Setup.exe',
    macos: 'PiDesk-macOS-universal.dmg',
    android: 'PiDesk-Android.apk'
  }
  assert.ok(Object.hasOwn(files, platform), '客户端平台无效')
  return files[platform]
}

export function validateRecord(record) {
  assert.ok(record && typeof record === 'object', '发布记录必须是对象')
  assert.match(record.tag, releaseTagPattern)
  assert.ok(Number.isSafeInteger(record.date) && record.date > 0, '发布日期无效')
  assert.match(record.source?.head, /^[a-f0-9]{40}$/)
  if (record.source.base !== null) assert.match(record.source.base, /^[a-f0-9]{40}$/)
  assert.ok(Array.isArray(record.packages) && record.packages.length > 0, '缺少 npm 版本清单')
  const names = new Set()
  for (const item of record.packages) {
    assert.match(item.name, /^@jetcrab\/pi-desk(?:-[a-z0-9-]+)?$/)
    assert.match(item.version, /^\d+\.\d+\.\d+$/)
    assert.ok(!names.has(item.name), 'npm 包重复')
    names.add(item.name)
  }
  assert.ok(Array.isArray(record.clients), '客户端清单无效')
  const platforms = new Set()
  for (const item of record.clients) {
    assert.ok(clientPlatforms.includes(item.platform), '客户端平台无效')
    assert.ok(!platforms.has(item.platform), '客户端平台重复')
    platforms.add(item.platform)
    assert.match(item.version, /^\d+\.\d+\.\d+$/)
    assert.match(item.sha256, /^[a-f0-9]{64}$/)
    assert.equal(item.file, clientFilename(item.platform))
  }
  assert.deepEqual(Object.keys(record.changes).sort(), [...changeSections].sort())
  for (const key of changeSections) {
    assert.ok(Array.isArray(record.changes[key]), '变更章节无效')
    assert.ok(
      record.changes[key].every((item) => typeof item === 'string' && item.trim().length > 0),
      '变更条目无效'
    )
  }
  return record
}

export function downloadUrl(repository, tag, filename) {
  assert.match(repository, /^[\w.-]+\/[\w.-]+$/)
  assert.ok(filename && !/[\\/]/u.test(filename), '下载文件名无效')
  return `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(filename)}`
}
