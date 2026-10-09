import assert from 'node:assert/strict'

export async function readPublishedVersions(name, fetchImpl = fetch) {
  assert.match(name, /^@jetcrab\/pi-desk(?:-[a-z0-9-]+)?$/)
  const response = await fetchImpl(
    `https://registry.npmjs.org/${encodeURIComponent(name)}?devVersions=${Date.now()}`,
    {
      headers: { accept: 'application/vnd.npm.install-v1+json', 'cache-control': 'no-cache' },
      signal: AbortSignal.timeout(30_000)
    }
  ).catch(() => {
    throw new Error(`无法读取 ${name} 的已发布版本：网络失败或超时`)
  })
  if (!response.ok) {
    await response.body?.cancel()
    if (response.status === 404) return []
    throw new Error(`无法读取 ${name} 的已发布版本：HTTP ${response.status}`)
  }
  const chunks = []
  let size = 0
  for await (const chunk of response.body) {
    size += chunk.length
    assert.ok(size <= 16 * 1024 * 1024, `${name} 的版本清单超过读取上限`)
    chunks.push(chunk)
  }
  let metadata
  try {
    metadata = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new Error(`${name} 的版本响应无效`)
  }
  assert.ok(
    metadata?.versions &&
      typeof metadata.versions === 'object' &&
      !Array.isArray(metadata.versions),
    `${name} 的已发布版本清单无效`
  )
  return Object.keys(metadata.versions)
}
