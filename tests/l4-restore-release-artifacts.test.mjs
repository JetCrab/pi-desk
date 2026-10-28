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

const timestamp = (minute) => `2026-10-27T00:${String(minute).padStart(2, '0')}:00Z`
const artifact = (name, minute = 2) => ({
  name: `${name}-11`,
  expired: false,
  created_at: timestamp(minute)
})
const job = (name, id, attempt = 1, start = 1, end = 3) => ({
  id,
  name,
  run_attempt: attempt,
  started_at: timestamp(start),
  completed_at: timestamp(end),
  conclusion: 'success'
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
  const artifacts = ['release-plan', 'client-windows', 'npm-packages', 'npm-command-smoke'].map(
    (name) => artifact(name)
  )
  const jobs = [
    job('windows / windows', 1),
    job('npm-build / build', 2),
    job('npm-build / installed-commands (ubuntu-latest)', 3, 1, 4, 5),
    job('npm-build / installed-commands (windows-latest)', 4, 1, 4, 5)
  ]
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
  await mkdir(join(source, 'npm-command-smoke-11'))
  await cp(
    join(source, 'npm-packages-11/jetcrab-pi-desk-1.1.5.tgz'),
    join(source, 'npm-command-smoke-11/host.tgz')
  )
  await cp(
    join(source, 'npm-packages-11/jetcrab-pi-desk-1.1.5.tgz'),
    join(source, 'npm-command-smoke-11/sdk.tgz')
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

async function dockerInputsFixture(f) {
  const directory = join(f.source, 'docker-inputs-11')
  f.input.plan.record.packages.push({ name: '@jetcrab/pi-desk-sdk', version: '1.1.5' })
  await writeFile(join(f.source, 'release-plan-11/plan.json'), JSON.stringify(f.input.plan))
  await mkdir(join(directory, 'host'), { recursive: true })
  await mkdir(join(directory, 'pi'), { recursive: true })
  await cp(
    join(f.source, 'npm-packages-11/jetcrab-pi-desk-1.1.5.tgz'),
    join(directory, 'host/host.tgz')
  )
  const sdk = join(f.root, 'sdk')
  await mkdir(join(sdk, 'package'), { recursive: true })
  await writeFile(
    join(sdk, 'package/package.json'),
    JSON.stringify({
      name: '@jetcrab/pi-desk-sdk',
      version: '1.1.5',
      publishConfig: { registry: 'https://registry.npmjs.org', access: 'public' }
    })
  )
  execFileSync(
    process.platform === 'win32' ? 'tar.exe' : 'tar',
    ['-czf', relative(sdk, join(directory, 'host/sdk.tgz')).replaceAll('\\', '/'), 'package'],
    { cwd: sdk, stdio: 'pipe' }
  )
  const files = {
    'host/package.json': JSON.stringify({
      private: true,
      dependencies: { '@jetcrab/pi-desk': 'file:host.tgz', '@jetcrab/pi-desk-sdk': 'file:sdk.tgz' }
    }),
    'host/package-lock.json': '{"lockfileVersion":3,"packages":{}}',
    'pi/package.json': JSON.stringify({
      private: true,
      dependencies: { '@earendil-works/pi-coding-agent': '1.2.0' }
    }),
    'pi/package-lock.json': '{"lockfileVersion":3,"packages":{}}',
    Dockerfile: 'FROM node:22\n',
    '.dockerignore': 'node_modules\n',
    'prune-image.mjs': 'export {}\n'
  }
  for (const [name, bytes] of Object.entries(files)) await writeFile(join(directory, name), bytes)
  const digests = Object.fromEntries(
    await Promise.all(
      [...Object.keys(files), 'host/host.tgz', 'host/sdk.tgz'].map(async (name) => [
        name,
        sha256(await readFile(join(directory, name)))
      ])
    )
  )
  await writeFile(
    join(directory, 'docker-inputs.json'),
    JSON.stringify({ source: f.input.plan.record.source.head, files: digests })
  )
  f.artifacts.push(artifact('docker-inputs'))
  return directory
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

test('安装态验收未成功时保留npm原包与安装态输入重验，已通过的平台仍可恢复', async (t) => {
  const f = await fixture(t)
  f.jobs.find(
    (item) => item.name === 'npm-build / installed-commands (windows-latest)'
  ).conclusion = 'failure'
  const result = await restoreReleaseArtifacts(f.input)
  assert.ok(existsSync(clientPath(f)))
  assert.ok(existsSync(npmPath(f)))
  assert.equal(result.npmVerified, false)
  assert.deepEqual(
    await readFile(npmPath(f)),
    await readFile(join(f.source, 'npm-packages-11/jetcrab-pi-desk-1.1.5.tgz'))
  )
  assert.ok(existsSync(join(f.root, 'npm-command-smoke/host.tgz')))
})

test('旧attempt成功不能放行重建后的新附件，保留新原包重新验收', async (t) => {
  const f = await fixture(t)
  for (const item of f.artifacts.filter((item) => item.name !== 'release-plan-11'))
    item.created_at = timestamp(12)
  f.jobs.push(
    { ...job('windows / windows', 11, 2, 11, 13), conclusion: 'failure' },
    job('npm-build / build', 12, 2, 11, 13),
    job('npm-build / installed-commands (ubuntu-latest)', 13, 2, 14, 15),
    {
      ...job('npm-build / installed-commands (windows-latest)', 14, 2, 14, 15),
      conclusion: 'failure'
    }
  )
  const result = await restoreReleaseArtifacts(f.input)
  assert.equal(existsSync(clientPath(f)), false)
  assert.ok(existsSync(npmPath(f)))
  assert.equal(result.npmVerified, false)
})

test('同一原附件跨attempt仍使用对应旧成功证据，不要求latest任务成功', async (t) => {
  const f = await fixture(t)
  f.jobs.push(
    { ...job('windows / windows', 11, 2, 11, 13), conclusion: 'failure' },
    {
      ...job('npm-build / installed-commands (windows-latest)', 14, 2, 14, 15),
      conclusion: 'failure'
    }
  )
  const result = await restoreReleaseArtifacts(f.input)
  assert.equal(result.npmVerified, true)
  assert.deepEqual(
    await readFile(join(f.root, 'clients/client-windows-12/installer.exe')),
    f.client
  )
})

test('原附件可由后续attempt重新验收通过，不因原attempt失败而重建', async (t) => {
  const f = await fixture(t)
  f.jobs.find(
    (item) => item.name === 'npm-build / installed-commands (windows-latest)'
  ).conclusion = 'failure'
  f.jobs.push(
    job('npm-build / build', 12, 2, 11, 13),
    job('npm-build / installed-commands (ubuntu-latest)', 13, 2, 14, 15),
    job('npm-build / installed-commands (windows-latest)', 14, 2, 14, 15)
  )
  assert.equal((await restoreReleaseArtifacts(f.input)).npmVerified, true)
})

test('验收证据缺失且安装态附件不属于同次构建时阻断，已下载原包保留', async (t) => {
  const f = await fixture(t)
  f.jobs.find(
    (item) => item.name === 'npm-build / installed-commands (windows-latest)'
  ).conclusion = 'failure'
  f.artifacts.find((item) => item.name === 'npm-command-smoke-11').created_at = timestamp(12)
  await assert.rejects(restoreReleaseArtifacts(f.input), /缺少同次构建的安装态附件/)
  assert.ok(existsSync(npmPath(f)))
})

test('缺少上传时间证据时不能借用任意成功任务或重新构建npm', async (t) => {
  const f = await fixture(t)
  delete f.artifacts.find((item) => item.name === 'npm-packages-11').created_at
  await assert.rejects(restoreReleaseArtifacts(f.input), /缺少对应构建证据/)
})

test('准备阶段重传的未验收包不能因历史构建成功而放行', async (t) => {
  const f = await fixture(t)
  for (const item of f.artifacts.filter((item) => item.name.startsWith('npm-')))
    item.created_at = timestamp(12)
  f.jobs.push(
    job('prepare', 11, 2, 11, 13),
    job('npm-build / build', 12, 2, 14, 15),
    job('npm-build / installed-commands (ubuntu-latest)', 13, 2, 16, 17),
    {
      ...job('npm-build / installed-commands (windows-latest)', 14, 2, 16, 17),
      conclusion: 'failure'
    }
  )
  assert.equal((await restoreReleaseArtifacts(f.input)).npmVerified, false)
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
  f.jobs.splice(
    0,
    f.jobs.length,
    job('prepare', 1),
    { ...job('windows', 2), conclusion: 'skipped' },
    { ...job('npm-build', 3), conclusion: 'skipped' }
  )
  await restoreReleaseArtifacts(f.input)
  assert.deepEqual(
    await readFile(join(f.root, 'clients/client-windows-12/installer.exe')),
    f.client
  )
  assert.ok(existsSync(npmPath(f)))
})

test('准备阶段重传附件兼容跳过的子job，但缺少跳过证据时要求npm重验', async (t) => {
  const f = await fixture(t)
  f.jobs.splice(
    0,
    f.jobs.length,
    job('prepare', 1),
    { ...job('windows / windows', 2), conclusion: 'skipped' },
    { ...job('npm-build / build', 3), conclusion: 'skipped' }
  )
  assert.equal((await restoreReleaseArtifacts(f.input)).npmVerified, true)
  await rm(join(f.root, 'npm'), { recursive: true })
  f.jobs.splice(1)
  assert.equal((await restoreReleaseArtifacts(f.input)).npmVerified, false)
})

test('不含宿主的原包没有对应构建成功记录时阻断，不能仅跳过构建放行', async (t) => {
  const f = await fixture(t)
  f.input.plan.npm = ['pi-desk-sdk']
  f.input.plan.record.packages.push({ name: '@jetcrab/pi-desk-sdk', version: '1.1.5' })
  await writeFile(join(f.source, 'release-plan-11/plan.json'), JSON.stringify(f.input.plan))
  f.jobs.splice(0, f.jobs.length, job('prepare', 1), {
    ...job('npm-build / build', 2, 1, 4, 5),
    conclusion: 'failure'
  })
  await assert.rejects(restoreReleaseArtifacts(f.input), /缺少对应验证证据/)
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

test('新说明和镜像附件不能使用旧attempt的成功任务', async (t) => {
  const f = await fixture(t)
  f.artifacts.push(artifact('release-review', 12), artifact('docker-image', 12))
  f.jobs.push(
    job('notes', 5),
    job('docker-build / build', 6),
    { ...job('notes', 15, 2, 11, 13), conclusion: 'failure' },
    { ...job('docker-build / build', 16, 2, 11, 13), conclusion: 'failure' }
  )
  await restoreReleaseArtifacts(f.input)
  assert.equal(existsSync(join(f.root, 'notes/changes.json')), false)
  assert.equal(existsSync(join(f.root, 'docker/docker-image.json')), false)
})

test('镜像构建失败仍跨run恢复固定安装输入和隐藏文件，不重新生成锁', async (t) => {
  const f = await fixture(t)
  const directory = await dockerInputsFixture(f)
  f.jobs.push({ ...job('docker-build / build', 6), conclusion: 'failure' })
  await restoreReleaseArtifacts(f.input)
  for (const file of [
    'host/package-lock.json',
    'pi/package-lock.json',
    '.dockerignore',
    'docker-inputs.json'
  ])
    assert.deepEqual(
      await readFile(join(f.root, 'docker-inputs', file)),
      await readFile(join(directory, file))
    )
  assert.ok(f.calls.includes('docker-inputs-11'))
})

test('固定镜像输入拒绝错源码、摘要和npm原包，不以坏输入重建', async (t) => {
  for (const fault of ['source', 'digest', 'npm']) {
    const f = await fixture(t)
    const directory = await dockerInputsFixture(f)
    const path = join(directory, 'docker-inputs.json')
    const record = JSON.parse(await readFile(path))
    if (fault === 'source') record.source = 'f'.repeat(40)
    if (fault === 'digest') await writeFile(join(directory, 'host/package-lock.json'), 'changed')
    if (fault === 'npm') {
      const packageRoot = join(f.root, 'package-source')
      const manifestPath = join(packageRoot, 'package/package.json')
      const manifest = JSON.parse(await readFile(manifestPath))
      await writeFile(manifestPath, JSON.stringify({ ...manifest, description: 'different bytes' }))
      execFileSync(
        process.platform === 'win32' ? 'tar.exe' : 'tar',
        [
          '-czf',
          relative(packageRoot, join(directory, 'host/host.tgz')).replaceAll('\\', '/'),
          'package'
        ],
        { cwd: packageRoot, stdio: 'pipe' }
      )
      record.files['host/host.tgz'] = sha256(await readFile(join(directory, 'host/host.tgz')))
    }
    await writeFile(path, JSON.stringify(record))
    await assert.rejects(restoreReleaseArtifacts(f.input), /源码批次|摘要|npm 原包不同/)
  }
})

test('没有成功镜像且固定安装输入过期时阻断，不重新解析依赖', async (t) => {
  const f = await fixture(t)
  await dockerInputsFixture(f)
  f.artifacts.find((item) => item.name === 'docker-inputs-11').expired = true
  await assert.rejects(restoreReleaseArtifacts(f.input), /安装输入已过期/)
})

test('较早run有成功镜像时优先复用镜像，不下载较新run的安装输入', async (t) => {
  const f = await fixture(t)
  await dockerInputsFixture(f)
  const image = Buffer.from('verified earlier image')
  await mkdir(join(f.source, 'docker-image-11'))
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
  const request = f.input.github.request
  f.input.github.request = async (path) => {
    if (path.includes('/workflows/')) return { workflow_runs: [{ id: 11 }, { id: 10 }] }
    if (path.startsWith('/actions/runs/10/artifacts'))
      return {
        artifacts: [
          { ...artifact('release-plan'), name: 'release-plan-10' },
          { ...artifact('docker-image'), name: 'docker-image-10' }
        ]
      }
    if (path.startsWith('/actions/runs/10/jobs')) return { jobs: [job('docker-build / build', 6)] }
    return request(path)
  }
  const download = f.input.download
  f.input.download = async (run, name, output) =>
    download(11, run === 10 ? name.replace(/-10$/, '-11') : name, output)
  await restoreReleaseArtifacts(f.input)
  assert.deepEqual(await readFile(join(f.root, 'docker/pi-desk-docker.tar.gz')), image)
  assert.equal(f.calls.includes('docker-inputs-11'), false)
})

test('通过审查的说明和镜像归档从同一固定计划恢复', async (t) => {
  const f = await fixture(t)
  f.artifacts.push(artifact('release-review'), artifact('docker-image'))
  f.jobs.push(job('notes', 5), job('docker-build / build', 6))
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
