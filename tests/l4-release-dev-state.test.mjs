import assert from 'node:assert/strict'
import test from 'node:test'
import {
  loadDevState,
  selectDevUnits,
  loadDevBatch,
  saveDevBatch,
  completeDevBatch
} from '../.github/scripts/release-dev-state.mjs'

function githubFixture() {
  const files = new Map()
  const requests = []
  let sequence = 0
  const github = {
    async request(path, options = {}) {
      requests.push({ path, ...options })
      if (path === '/git/ref/heads/release-data') return { object: { sha: 'a'.repeat(40) } }
      if (path.startsWith('/compare/')) return { status: 'ahead' }
      if (path.startsWith('/contents/')) {
        const name = path.slice('/contents/'.length).split('?')[0]
        const previous = files.get(name)
        if (!options.method || options.method === 'GET') return previous ?? null
        assert.equal(options.method, 'PUT')
        assert.equal(options.body.branch, 'release-data')
        assert.equal(options.body.sha, previous?.sha)
        const next = { content: options.body.content, encoding: 'base64', sha: String(++sequence) }
        files.set(name, next)
        return { content: next }
      }
      throw new Error(`未预期的GitHub操作：${path}`)
    }
  }
  return { github, files, requests }
}

const source = 'b'.repeat(40)
function batch(runId = '123') {
  return {
    runId,
    source,
    versions: { 'pi-desk': '1.0.8', windows: '1.1.2', macos: '1.1.2' },
    selected: ['pi-desk', 'windows', 'macos'],
    npmVersions: { 'pi-desk': '1.0.8-dev.1' }
  }
}

test('失败后未变化的版本仍被选择，成功组件不重复选择', () => {
  const state = { checks: null, units: { windows: { version: '1.1.2', source, runId: '120' } } }
  assert.deepEqual(selectDevUnits(batch().versions, state), ['pi-desk', 'macos'])
  assert.throws(() => selectDevUnits({ windows: '1.1.1' }, state), /版本|回退/)
})

test('同一运行重试恢复固定开发版本，不覆盖不同的计划', async () => {
  const { github } = githubFixture()
  assert.equal(await loadDevBatch(github, '123'), null)
  await saveDevBatch(github, batch())
  assert.deepEqual(await loadDevBatch(github, '123'), batch())
  await saveDevBatch(github, batch())
  await assert.rejects(
    saveDevBatch(github, { ...batch(), npmVersions: { 'pi-desk': '1.0.8-dev.2' } }),
    /不同|覆盖/
  )
})

test('部分失败只推进已验收单元，空跑成功不伪造缺失单元', async () => {
  const { github } = githubFixture()
  await saveDevBatch(github, batch())
  await completeDevBatch(github, batch(), {
    checks: 'success',
    'npm-build': 'success',
    'npm-publish': 'failure',
    windows: 'success',
    macos: 'failure'
  })
  const state = await loadDevState(github)
  assert.equal(state.units.windows.version, '1.1.2')
  assert.equal(state.units['pi-desk'], undefined)
  assert.equal(state.units.macos, undefined)
  assert.equal(state.checks, source)
  await completeDevBatch(
    github,
    { ...batch('124'), source: 'c'.repeat(40), selected: [] },
    {
      checks: 'success',
      'npm-build': 'skipped',
      'npm-publish': 'skipped',
      windows: 'skipped',
      macos: 'skipped'
    }
  )
  assert.deepEqual(selectDevUnits(batch().versions, await loadDevState(github)), [
    'pi-desk',
    'macos'
  ])
})

test('发布成功但记录写入重试是幂等的，取消不抹掉成功结果', async () => {
  const { github } = githubFixture()
  const results = {
    checks: 'success',
    'npm-build': 'success',
    'npm-publish': 'success',
    windows: 'success',
    macos: 'cancelled'
  }
  await completeDevBatch(github, batch(), results)
  const first = await loadDevState(github)
  assert.equal(first.units['pi-desk'].version, '1.0.8')
  assert.equal(first.units.macos, undefined)
  await completeDevBatch(github, batch(), results)
  assert.deepEqual(await loadDevState(github), first)
  await completeDevBatch(github, batch(), {
    checks: 'failure',
    windows: 'skipped',
    macos: 'skipped',
    'npm-build': 'skipped',
    'npm-publish': 'skipped'
  })
  assert.deepEqual(await loadDevState(github), first)
})

test('构建通过但源码检查失败，不推进受该检查约束的npm单元', async () => {
  const { github } = githubFixture()
  await completeDevBatch(github, batch(), {
    checks: 'failure',
    'npm-build': 'success',
    'npm-publish': 'skipped',
    windows: 'failure',
    macos: 'failure'
  })
  assert.deepEqual(await loadDevState(github), { checks: null, units: {} })
})
