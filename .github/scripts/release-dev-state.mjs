import assert from 'node:assert/strict'
import { isDeepStrictEqual } from 'node:util'
import { versionParts } from './npm-channel.mjs'

const branch = 'release-data'
const statePath = 'dev/state.json'
const nativeUnits = new Set(['windows', 'macos', 'android', 'ios', 'tunnel'])
const sourcePattern = /^[a-f0-9]{40}$/
const runPattern = /^[1-9]\d*$/

function validateUnit(id) {
  assert.ok(nativeUnits.has(id) || /^pi-desk(?:-[a-z0-9-]+)?$/.test(id), `未知开发单元：${id}`)
}

function stableParts(version) {
  const parts = versionParts(version)
  assert.equal(parts[3], null, '开发状态必须记录稳定数字版本')
  return parts.slice(0, 3)
}

function compareVersions(left, right) {
  const a = stableParts(left)
  const b = stableParts(right)
  const index = a.findIndex((value, i) => value !== b[i])
  return index === -1 ? 0 : Math.sign(a[index] - b[index])
}

function validateState(state) {
  assert.ok(isDeepStrictEqual(Object.keys(state).sort(), ['checks', 'units']), '开发状态字段无效')
  if (state.checks !== null) assert.match(state.checks, sourcePattern)
  assert.ok(state.units && typeof state.units === 'object' && !Array.isArray(state.units))
  for (const [id, unit] of Object.entries(state.units)) {
    validateUnit(id)
    assert.ok(
      isDeepStrictEqual(Object.keys(unit).sort(), ['runId', 'source', 'version']),
      '开发单元字段无效'
    )
    stableParts(unit.version)
    assert.match(unit.source, sourcePattern)
    assert.match(unit.runId, runPattern)
  }
  return state
}

function validateBatch(batch) {
  assert.ok(
    isDeepStrictEqual(Object.keys(batch).sort(), [
      'npmVersions',
      'runId',
      'selected',
      'source',
      'versions'
    ]),
    '开发批次字段无效'
  )
  assert.match(batch.runId, runPattern)
  assert.match(batch.source, sourcePattern)
  assert.ok(batch.versions && typeof batch.versions === 'object' && !Array.isArray(batch.versions))
  for (const [id, version] of Object.entries(batch.versions)) {
    validateUnit(id)
    stableParts(version)
  }
  assert.ok(Array.isArray(batch.selected), '开发批次缺少选择列表')
  assert.equal(new Set(batch.selected).size, batch.selected.length, '开发单元重复')
  for (const id of batch.selected) {
    assert.ok(Object.hasOwn(batch.versions, id), `开发批次缺少版本：${id}`)
  }
  assert.ok(
    batch.npmVersions && typeof batch.npmVersions === 'object' && !Array.isArray(batch.npmVersions)
  )
  for (const [id, version] of Object.entries(batch.npmVersions)) {
    assert.match(id, /^pi-desk(?:-[a-z0-9-]+)?$/)
    assert.notEqual(versionParts(version)[3], null, 'npm开发版本必须带预发布后缀')
    assert.equal(
      version.split('-dev.')[0],
      batch.versions[id],
      `npm开发版本与单元版本不匹配：${id}`
    )
  }
  return batch
}

async function readFile(github, path) {
  return github.request(`/contents/${path}?ref=${branch}`, { allow404: true })
}

function decode(file) {
  assert.equal(file.encoding, 'base64', '开发发布数据编码无效')
  return JSON.parse(Buffer.from(file.content, 'base64').toString('utf8'))
}

// Contents API在其他路径推进分支时也可能冲突；重读后重新决策，不重放旧状态。
async function updateFile(github, path, change) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const reference = await github.request(`/git/ref/heads/${branch}`, { allow404: true })
    const previous = reference ? await readFile(github, path) : null
    const value = await change(previous ? decode(previous) : null)
    if (value === null) return
    const content = JSON.stringify(value, null, 2) + '\n'
    const message = `Record ${path}`
    try {
      if (reference) {
        await github.request(`/contents/${path}`, {
          method: 'PUT',
          body: {
            branch,
            message,
            content: Buffer.from(content).toString('base64'),
            ...(previous ? { sha: previous.sha } : {})
          }
        })
      } else {
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
      return
    } catch (error) {
      if (!/HTTP (409|422)\b/.test(error.message) || attempt === 2) throw error
      if (/HTTP 422\b/.test(error.message)) {
        const latest = await github.request(`/git/ref/heads/${branch}`, { allow404: true })
        if (!latest || latest.object.sha === reference?.object.sha) throw error
      }
      console.warn(`开发发布数据写入冲突，重读后重试：${path}（${attempt + 1}/2）`)
    }
  }
}

/** @returns {Promise<{checks: string|null, units: Record<string, {version: string, source: string, runId: string}>}>} */
export async function loadDevState(github) {
  const file = await readFile(github, statePath)
  return file ? validateState(decode(file)) : { checks: null, units: {} }
}

/** @returns {string[]} */
export function selectDevUnits(versions, state) {
  validateState(state)
  return Object.entries(versions)
    .filter(([id, version]) => {
      validateUnit(id)
      stableParts(version)
      const previous = state.units[id]
      if (!previous) return true
      const comparison = compareVersions(version, previous.version)
      assert.ok(comparison >= 0, `${id} 版本回退：${previous.version} → ${version}`)
      return comparison > 0
    })
    .map(([id]) => id)
}

/** @returns {Promise<object|null>} */
export async function loadDevBatch(github, runId) {
  assert.match(runId, runPattern)
  const file = await readFile(github, `dev/batches/${runId}.json`)
  if (!file) return null
  const batch = validateBatch(decode(file))
  assert.equal(batch.runId, runId, '开发批次身份不匹配')
  return batch
}

/** @returns {Promise<void>} */
export async function saveDevBatch(github, batch) {
  validateBatch(batch)
  await updateFile(github, `dev/batches/${batch.runId}.json`, (previous) => {
    if (!previous) return batch
    validateBatch(previous)
    assert.ok(isDeepStrictEqual(previous, batch), '已保存的开发批次计划不同，拒绝覆盖')
    return null
  })
}

/** @returns {Promise<void>} */
export async function completeDevBatch(github, batch, results) {
  validateBatch(batch)
  await updateFile(github, statePath, async (previous) => {
    const state = previous ? validateState(previous) : { checks: null, units: {} }
    const next = { checks: state.checks, units: { ...state.units } }
    if (results.checks === 'success' && state.checks !== batch.source) {
      if (state.checks === null) {
        next.checks = batch.source
      } else {
        // checks仅保存SHA，提交关系是避免旧批次回退检查来源的权威依据。
        const comparison = await github.request(`/compare/${state.checks}...${batch.source}`)
        if (comparison.status === 'ahead') next.checks = batch.source
        else {
          assert.ok(
            ['behind', 'identical', 'diverged'].includes(comparison.status),
            '检查源码比较结果无效'
          )
          if (comparison.status === 'diverged') {
            console.warn('开发检查源码已分叉，保留已有成功记录；调用者需校验源码关系。')
          }
        }
      }
    }
    const npmSuccess = ['checks', 'npm-build', 'npm-publish'].every(
      (name) => results[name] === 'success'
    )
    for (const id of batch.selected) {
      if (nativeUnits.has(id) ? results[id] !== 'success' : !npmSuccess) continue
      if (!nativeUnits.has(id)) {
        assert.ok(Object.hasOwn(batch.npmVersions, id), `缺少已发布的npm开发版本：${id}`)
      }
      const version = batch.versions[id]
      const old = state.units[id]
      // 相同版本保留原来源；源码等价性由调用者校验，旧批次不能覆盖新事实。
      if (old && compareVersions(version, old.version) <= 0) continue
      next.units[id] = { version, source: batch.source, runId: batch.runId }
    }
    return isDeepStrictEqual(state, next) ? null : next
  })
}
