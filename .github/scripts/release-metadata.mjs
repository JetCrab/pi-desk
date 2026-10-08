import assert from 'node:assert/strict'
import { isDeepStrictEqual } from 'node:util'
import { releaseTagPattern, validateRecord } from './release-record.mjs'

const branch = 'release-data'

export async function loadReleaseRecord(github, tag, { optional = false } = {}) {
  assert.match(tag, releaseTagPattern)
  const file = await github.request(`/contents/releases/${tag}.json?ref=${branch}`, {
    allow404: true
  })
  if (!file) {
    assert.ok(optional, `缺少正式发布记录：${tag}`)
    return null
  }
  assert.equal(file.encoding, 'base64', '发布记录编码无效')
  const record = validateRecord(JSON.parse(Buffer.from(file.content, 'base64').toString('utf8')))
  assert.equal(record.tag, tag, '发布记录身份不匹配')
  return record
}

export async function saveReleaseRecord(github, record) {
  validateRecord(record)
  const reference = await github.request(`/git/ref/heads/${branch}`, { allow404: true })
  const content = JSON.stringify(record, null, 2) + '\n'
  const path = `releases/${record.tag}.json`
  const message = `Record ${record.tag}`
  if (reference) {
    const previous = await loadReleaseRecord(github, record.tag, { optional: true })
    if (previous) {
      assert.ok(isDeepStrictEqual(previous, record), '已保存的正式记录不同，拒绝覆盖')
      return
    }
    await github.request(`/contents/${path}`, {
      method: 'PUT',
      body: { branch, message, content: Buffer.from(content).toString('base64') }
    })
    return
  }
  const tree = await github.request('/git/trees', {
    method: 'POST',
    body: { tree: [{ path, mode: '100644', type: 'blob', content }] }
  })
  const commit = await github.request('/git/commits', {
    method: 'POST',
    body: { message, tree: tree.sha, parents: [] }
  })
  await github.request('/git/refs', {
    method: 'POST',
    body: { ref: `refs/heads/${branch}`, sha: commit.sha }
  })
}
