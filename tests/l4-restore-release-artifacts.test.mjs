import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import test, { beforeEach } from 'node:test'
import { format } from 'node:util'
import {
  findReleasePlan,
  restoreReleaseArtifacts
} from '../.github/scripts/restore-release-artifacts.mjs'
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
  const calls = [],
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
    }
  }
  const input = {
    github,
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
  return { root, source, input, artifacts, jobs, calls, client }
}

const clientPath = (f) => join(f.root, 'clients/client-windows-12/release.json')
const npmPath = (f) => join(f.root, 'npm/jetcrab-pi-desk-1.1.5.tgz')

test('整批失败仍恢复成功平台和已验收npm原字节，不依赖Release草稿', async (t) => {
  const f = await fixture(t)
  await restoreReleaseArtifacts(f.input)
  assert.deepEqual(
    await readFile(join(f.root, 'clients/client-windows-12/installer.exe')),
    f.client
  )
  assert.ok(existsSync(npmPath(f)))
  const restoredFiles = () => f.calls.filter((name) => !name.startsWith('release-plan-'))
  const files = restoredFiles()
  await restoreReleaseArtifacts(f.input)
  assert.deepEqual(restoredFiles(), files)
})

test('计划不同、产物过期或平台任务失败均不能复用', async (t) => {
  const f = await fixture(t)
  await writeFile(
    join(f.source, 'release-plan-11/plan.json'),
    JSON.stringify({
      ...f.input.plan,
      record: { ...f.input.plan.record, source: { head: 'b'.repeat(40), base: null } }
    })
  )
  await restoreReleaseArtifacts(f.input)
  assert.equal(existsSync(clientPath(f)), false)
  assert.equal(existsSync(npmPath(f)), false)
  await writeFile(join(f.source, 'release-plan-11/plan.json'), JSON.stringify(f.input.plan))
  f.artifacts.find((item) => item.name === 'npm-packages-11').expired = true
  f.jobs.find((item) => item.name === 'windows / windows').conclusion = 'failure'
  await restoreReleaseArtifacts(f.input)
  assert.equal(existsSync(clientPath(f)), false)
  assert.equal(existsSync(npmPath(f)), false)
})

test('安装态验收未成功时不复用npm，已通过的平台仍可恢复', async (t) => {
  const f = await fixture(t)
  f.jobs.find(
    (item) => item.name === 'npm-build / installed-commands (windows-latest)'
  ).conclusion = 'failure'
  await restoreReleaseArtifacts(f.input)
  assert.ok(existsSync(clientPath(f)))
  assert.equal(existsSync(npmPath(f)), false)
})

test('同计划制品版本或摘要不一致直接失败，不发布不一致字节', async (t) => {
  const f = await fixture(t)
  const manifest = join(f.source, 'client-windows-11/release.json')
  await writeFile(manifest, JSON.stringify({ version: '1.1.4', sha256: sha256(f.client) }))
  await assert.rejects(restoreReleaseArtifacts(f.input), /恢复版本/)
  await writeFile(manifest, JSON.stringify({ version: '1.1.5', sha256: '0'.repeat(64) }))
  await assert.rejects(restoreReleaseArtifacts(f.input), /摘要不一致/)
  assert.equal(existsSync(clientPath(f)), false)
})

test('没有Release时仍能按版本找到固定计划，源码不匹配不能误用', async (t) => {
  const f = await fixture(t)
  assert.deepEqual(await findReleasePlan({ ...f.input, tag: 'v1.1.5' }), f.input.plan)
  assert.equal(await findReleasePlan({ ...f.input, source: 'b'.repeat(40) }), null)
  assert.equal(await findReleasePlan({ ...f.input, tag: 'v1.1.6' }), null)
})

test('准备阶段已恢复且后续构建跳过的原制品仍可再次复用', async (t) => {
  const f = await fixture(t)
  f.jobs.splice(0, f.jobs.length, { name: 'prepare', conclusion: 'success' })
  await restoreReleaseArtifacts(f.input)
  assert.deepEqual(
    await readFile(join(f.root, 'clients/client-windows-12/installer.exe')),
    f.client
  )
  assert.ok(existsSync(npmPath(f)))
})

test('本次运行的固定计划过期时停止重试，不重新分配版本', async (t) => {
  const f = await fixture(t)
  f.artifacts.find((item) => item.name === 'release-plan-11').expired = true
  await assert.rejects(
    findReleasePlan({ ...f.input, runId: '11', tag: 'v1.1.5' }),
    /固定计划.*过期/
  )
})

test('本次运行的固定计划不接受另一个源码或版本', async (t) => {
  const f = await fixture(t)
  await assert.rejects(
    findReleasePlan({ ...f.input, runId: '11', source: 'b'.repeat(40) }),
    /固定源码不同/
  )
  await assert.rejects(findReleasePlan({ ...f.input, runId: '11', tag: 'v1.1.6' }), /固定版本不同/)
})

test('通过审查的说明和镜像归档从同一固定计划恢复', async (t) => {
  const f = await fixture(t)
  f.artifacts.push(
    { name: 'release-review-11', expired: false },
    { name: 'docker-image-11', expired: false }
  )
  f.jobs.push(
    { name: 'notes', conclusion: 'success' },
    { name: 'docker-build / build', conclusion: 'success' }
  )
  await mkdir(join(f.source, 'release-review-11'))
  await writeFile(
    join(f.source, 'release-review-11/changes.json'),
    JSON.stringify(f.input.plan.record.changes)
  )
  await mkdir(join(f.source, 'docker-image-11'))
  const image = Buffer.from('verified image')
  await writeFile(join(f.source, 'docker-image-11/pi-desk-docker.tar.gz'), image)
  await writeFile(
    join(f.source, 'docker-image-11/docker-image.json'),
    JSON.stringify({
      source: f.input.plan.record.source.head,
      version: '1.1.5',
      imageId: `sha256:${'b'.repeat(64)}`,
      sha256: sha256(image)
    })
  )
  await restoreReleaseArtifacts(f.input)
  assert.deepEqual(
    JSON.parse(await readFile(join(f.root, 'notes/changes.json'))),
    f.input.plan.record.changes
  )
  assert.deepEqual(await readFile(join(f.root, 'docker/pi-desk-docker.tar.gz')), image)
})
