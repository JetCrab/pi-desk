import assert from 'node:assert/strict'
import test from 'node:test'
import {
  saveDevBatch,
  loadDevArtifactSources,
  recordDevArtifactSources
} from '../.github/scripts/release-dev-state.mjs'

function fixture() {
  const files = new Map()
  let revision = 0
  const github = {
    async request(path, options = {}) {
      if (path === '/git/ref/heads/release-data') return { object: { sha: 'a'.repeat(40) } }
      assert.ok(path.startsWith('/contents/'), path)
      const name = path.split('?')[0]
      const old = files.get(name)
      if (options.method === 'PUT') {
        assert.equal(options.body.sha, old?.sha)
        files.set(name, {
          content: options.body.content,
          encoding: 'base64',
          sha: String(++revision)
        })
        return {}
      }
      return old ?? null
    }
  }
  return github
}
function plan(runId, version, selected = ['pi-desk-sdk', 'pi-desk']) {
  return {
    runId,
    source: 'b'.repeat(40),
    versions: Object.fromEntries(selected.map((name) => [name, version])),
    selected,
    npmVersions: Object.fromEntries(selected.map((name) => [name, version + '-dev']))
  }
}

test('构建成功后记录原制品来源，未完成发布也能按组件恢复', async () => {
  const github = fixture()
  assert.deepEqual(await loadDevArtifactSources(github), {})
  const first = plan('123', '1.2.3')
  await saveDevBatch(github, first)
  assert.deepEqual(await loadDevArtifactSources(github), {}, '仅建立计划不能宣称已有制品')
  await recordDevArtifactSources(github, first)
  assert.deepEqual(await loadDevArtifactSources(github), { 'pi-desk-sdk': '123', 'pi-desk': '123' })
  const next = plan('124', '1.2.4', ['pi-desk'])
  await saveDevBatch(github, next)
  await recordDevArtifactSources(github, next)
  assert.deepEqual(await loadDevArtifactSources(github), { 'pi-desk-sdk': '123', 'pi-desk': '124' })
  await recordDevArtifactSources(github, first)
  assert.deepEqual(
    await loadDevArtifactSources(github),
    { 'pi-desk-sdk': '123', 'pi-desk': '124' },
    '旧版本重跑不能回退制品索引'
  )
})

test('同版本新运行仅更新原制品副本的来源，不制造新版本', async () => {
  const github = fixture()
  for (const runId of ['123', '124']) {
    const batch = plan(runId, '1.2.3')
    await saveDevBatch(github, batch)
    await recordDevArtifactSources(github, batch)
  }
  assert.deepEqual(await loadDevArtifactSources(github), { 'pi-desk-sdk': '124', 'pi-desk': '124' })
  await recordDevArtifactSources(github, plan('123', '1.2.3'))
  assert.deepEqual(await loadDevArtifactSources(github), { 'pi-desk-sdk': '124', 'pi-desk': '124' })
})
