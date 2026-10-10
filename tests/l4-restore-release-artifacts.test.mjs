import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import test, { beforeEach } from 'node:test'
import { format } from 'node:util'
import { restoreReleaseArtifacts } from '../.github/scripts/restore-release-artifacts.mjs'
import { sha256 } from '../.github/scripts/release-github.mjs'

beforeEach((context) => {
  context.mock.method(console, 'info', (...args) => context.diagnostic(format(...args)))
})

async function fixture(context) {
  const parent = resolve('temp/run/restore-release-artifacts')
  await mkdir(parent, { recursive: true })
  const root = await mkdtemp(join(parent, 'same-source-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const plan = {
    record: {
      tag: 'v1.1.5',
      date: 1,
      source: { base: 'c'.repeat(40), head: 'a'.repeat(40) },
      packages: [{ name: '@jetcrab/pi-desk', version: '1.1.5' }],
      clients: [],
      changes: Object.fromEntries(
        ['breaking', 'features', 'added', 'changed', 'fixed', 'removed'].map((key) => [key, []])
      )
    },
    npm: ['pi-desk'],
    clients: [{ platform: 'windows', version: '1.1.5', build: true }],
    tunnel: false
  }
  const release = { draft: true, target_commitish: plan.record.source.head, assets: [] }
  const artifacts = ['release-plan', 'client-windows', 'npm-packages'].map((name) => ({
    name: `${name}-11`,
    expired: false
  }))
  const jobs = [
    'windows / windows',
    'npm-build / build',
    'npm-build / installed-commands (ubuntu-latest)',
    'npm-build / installed-commands (windows-latest)'
  ].map((name) => ({ name, conclusion: 'success' }))
  const saved = new Map(),
    calls = [],
    source = join(root, 'archives')
  await mkdir(join(source, 'client-windows-11'), { recursive: true })
  const client = Buffer.from('verified Windows installation bytes')
  await writeFile(join(source, 'client-windows-11', 'installer.exe'), client)
  await writeFile(
    join(source, 'client-windows-11', 'release.json'),
    JSON.stringify({ version: '1.1.5', sha256: sha256(client) })
  )
  await mkdir(join(source, 'release-plan-11'))
  await writeFile(join(source, 'release-plan-11', 'plan.json'), JSON.stringify(plan))
  const packageRoot = join(root, 'package-source')
  await mkdir(join(packageRoot, 'package'), { recursive: true })
  await writeFile(
    join(packageRoot, 'package/package.json'),
    JSON.stringify({
      name: '@jetcrab/pi-desk',
      version: '1.1.5',
      publishConfig: { registry: 'https://registry.npmjs.org', access: 'public' }
    })
  )
  await mkdir(join(source, 'npm-packages-11'))
  execFileSync(
    process.platform === 'win32' ? 'tar.exe' : 'tar',
    [
      '-czf',
      relative(
        packageRoot,
        join(source, 'npm-packages-11', 'jetcrab-pi-desk-1.1.5.tgz')
      ).replaceAll('\\', '/'),
      'package'
    ],
    { cwd: packageRoot, stdio: 'pipe' }
  )
  const github = {
    async request(path) {
      if (path.includes('/workflows/'))
        return { workflow_runs: [{ id: 11, status: 'completed', conclusion: 'failure' }] }
      if (path.includes('/artifacts?')) return { artifacts }
      if (path.includes('/jobs?')) return { jobs }
      throw new Error(`未声明的 GitHub 请求：${path}`)
    },
    async putAsset(_release, name, bytes) {
      saved.set(name, bytes)
      release.assets.push({ name, digest: `sha256:${sha256(bytes)}` })
    }
  }
  const input = {
    github,
    release,
    plan,
    runId: '12',
    repository: 'example/pi-desk',
    directory: root,
    async download(run, name, output) {
      assert.equal(run, 11)
      calls.push(name)
      await cp(join(source, name), output, { recursive: true })
    }
  }
  return { root, source, input, artifacts, jobs, saved, calls, client }
}

test('整批失败不丢弃成功平台和双平台验收后的npm，归档原字节后不重复恢复', async (t) => {
  const f = await fixture(t)
  await restoreReleaseArtifacts(f.input)
  assert.deepEqual(f.saved.get('PiDesk-Windows-x86-Setup.exe'), f.client)
  assert.ok(f.saved.has('jetcrab-pi-desk-1.1.5.tgz'))
  const count = f.calls.length
  await restoreReleaseArtifacts(f.input)
  assert.equal(f.calls.length, count)
})

test('计划不同、产物过期或平台任务失败均不能复用', async (t) => {
  const f = await fixture(t)
  await writeFile(
    join(f.source, 'release-plan-11', 'plan.json'),
    JSON.stringify({
      ...f.input.plan,
      record: { ...f.input.plan.record, source: { head: 'b'.repeat(40), base: null } }
    })
  )
  await restoreReleaseArtifacts(f.input)
  assert.equal(f.saved.size, 0)
  await writeFile(join(f.source, 'release-plan-11', 'plan.json'), JSON.stringify(f.input.plan))
  f.artifacts.find((item) => item.name === 'npm-packages-11').expired = true
  f.jobs.find((item) => item.name === 'windows / windows').conclusion = 'failure'
  await restoreReleaseArtifacts(f.input)
  assert.equal(f.saved.size, 0)
})

test('安装态验收未成功时不复用npm，已通过的平台仍可恢复', async (t) => {
  const f = await fixture(t)
  f.jobs.find(
    (item) => item.name === 'npm-build / installed-commands (windows-latest)'
  ).conclusion = 'failure'
  await restoreReleaseArtifacts(f.input)
  assert.ok(f.saved.has('PiDesk-Windows-x86-Setup.exe'))
  assert.equal(f.saved.has('jetcrab-pi-desk-1.1.5.tgz'), false)
})

test('同计划制品版本或摘要不一致直接失败，不发布不一致字节', async (t) => {
  const f = await fixture(t)
  const manifest = join(f.source, 'client-windows-11', 'release.json')
  await writeFile(manifest, JSON.stringify({ version: '1.1.4', sha256: sha256(f.client) }))
  await assert.rejects(restoreReleaseArtifacts(f.input), /恢复版本/)
  await writeFile(manifest, JSON.stringify({ version: '1.1.5', sha256: '0'.repeat(64) }))
  await assert.rejects(restoreReleaseArtifacts(f.input), /摘要不一致/)
  assert.equal(f.saved.size, 0)
})
