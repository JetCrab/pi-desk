import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

export function createGitHubClient({ repository, token, fetchImpl = fetch }) {
  assert.match(repository, /^[\w.-]+\/[\w.-]+$/)
  assert.ok(token, '缺少 GitHub 发布授权')
  const root = `https://api.github.com/repos/${repository}`
  async function request(path, { method = 'GET', body, binary = false, allow404 = false } = {}) {
    const url = path.startsWith('https:') ? path : `${root}${path}`
    assert.ok(
      url === root ||
        url.startsWith(root + '/') ||
        url.startsWith(`https://uploads.github.com/repos/${repository}/`),
      'GitHub 请求地址不属于当前仓库'
    )
    const response = await fetchImpl(url, {
      method,
      redirect: 'follow',
      signal: AbortSignal.timeout(120_000),
      headers: {
        authorization: `Bearer ${token}`,
        accept: binary ? 'application/octet-stream' : 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        ...(body !== undefined
          ? {
              'content-type': Buffer.isBuffer(body)
                ? 'application/octet-stream'
                : 'application/json'
            }
          : {})
      },
      body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body)
    }).catch(() => {
      throw new Error('GitHub 请求网络失败或超时')
    })
    if (allow404 && response.status === 404) return null
    assert.ok(response.ok, `GitHub 请求失败：HTTP ${response.status}`)
    if (response.status === 204) return null
    return binary ? Buffer.from(await response.arrayBuffer()) : response.json()
  }
  async function releases() {
    const result = []
    for (let page = 1; ; page += 1) {
      const values = await request(`/releases?per_page=100&page=${page}`)
      result.push(...values)
      if (values.length < 100) return result
    }
  }
  async function asset(release, name) {
    const entry = release.assets.find((value) => value.name === name)
    assert.ok(entry, `Release 缺少附件：${name}`)
    return request(`/releases/assets/${entry.id}`, { binary: true })
  }
  async function putAsset(release, name, bytes) {
    const old = release.assets.find((item) => item.name === name)
    if (old) {
      const existing = await asset(release, name)
      assert.equal(sha256(existing), sha256(bytes), `已有 Release 附件内容不同，拒绝覆盖：${name}`)
      return old
    }
    assert.equal(release.draft, true, '不向已公开 Release 追加或覆盖附件')
    const result = await request(
      `https://uploads.github.com/repos/${repository}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`,
      { method: 'POST', body: bytes }
    )
    release.assets.push(result)
    return result
  }
  return { request, releases, asset, putAsset }
}

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}
