import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import test from 'node:test'
import {
  dockerAssets,
  dockerInstallManifests,
  restoreDockerImage,
  stageDockerImage,
  publishDockerImage
} from '../.github/scripts/release-docker.mjs'
import { sha256 } from '../.github/scripts/release-github.mjs'
import { selectCiChecks } from '../.github/scripts/select-ci-checks.mjs'
import { evaluateWorkflowCondition, readWorkflow } from './fixtures/l4-workflow-test-runtime.mjs'

const source = 'a'.repeat(40)
const version = '1.2.3'
const imageId = `sha256:${'b'.repeat(64)}`
const digest = `sha256:${'c'.repeat(64)}`
const repository = 'ghcr.io/jetcrab/pi-desk'

async function fixture(t) {
  const parent = resolve('temp/tests/release-docker/image-regression')
  await mkdir(parent, { recursive: true })
  const directory = await mkdtemp(join(parent, 'batch-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return { directory }
}

function inspection(id = imageId) {
  return {
    Id: id,
    Config: {
      Labels: {
        'org.opencontainers.image.revision': source,
        'org.opencontainers.image.version': version
      }
    }
  }
}

test('镜像使用同批主包和SDK，Pi单独安装并拒绝开发版本', () => {
  const host = {
    name: '@jetcrab/pi-desk',
    version,
    devDependencies: {
      '@earendil-works/pi-coding-agent': '1.0.1'
    }
  }
  const sdk = { name: '@jetcrab/pi-desk-sdk', version: '1.1.0' }
  const manifests = dockerInstallManifests(host, sdk)
  assert.deepEqual(manifests.host.dependencies, {
    '@jetcrab/pi-desk': 'file:host.tgz',
    '@jetcrab/pi-desk-sdk': 'file:sdk.tgz'
  })
  assert.deepEqual(manifests.pi.dependencies, { '@earendil-works/pi-coding-agent': '1.0.1' })
  assert.throws(() => dockerInstallManifests({ ...host, version: '1.2.3-dev.1' }, sdk))
  assert.throws(() => dockerInstallManifests(host, { ...sdk, version: '1.1.0-dev.1' }))
})

test('工作流制品中的已验证镜像按原摘要复用，损坏或错批次禁止复用', async (t) => {
  const f = await fixture(t)
  const bytes = Buffer.from('same verified image')
  await writeFile(join(f.directory, dockerAssets.archive), bytes)
  await stageDockerImage({ ...f, source, version, imageId })
  assert.equal(await restoreDockerImage({ ...f, source, version }), true)
  assert.deepEqual(await readFile(join(f.directory, dockerAssets.archive)), bytes)
  const record = JSON.parse(await readFile(join(f.directory, dockerAssets.record)))
  assert.equal(record.sha256, sha256(bytes))
  await assert.rejects(restoreDockerImage({ ...f, source: 'd'.repeat(40), version }))
  await writeFile(join(f.directory, dockerAssets.archive), 'tampered')
  await assert.rejects(restoreDockerImage({ ...f, source, version }), /摘要/)
})

test('没有镜像制品时允许构建，但归档不完整时不能冒充可复用镜像', async (t) => {
  const f = await fixture(t)
  assert.equal(await restoreDockerImage({ ...f, source, version }), false)
  await writeFile(join(f.directory, dockerAssets.archive), 'verified image without record')
  await assert.rejects(restoreDockerImage({ ...f, source, version }), /记录|完整/)
})

test('首次发布推固定版本与latest，同摘要重试不覆盖固定版本', async (t) => {
  const f = await fixture(t)
  await writeFile(join(f.directory, dockerAssets.archive), 'verified')
  await stageDockerImage({ ...f, source, version, imageId })
  for (const existing of [null, digest]) {
    const calls = []
    const run = (args) => {
      calls.push(args)
      if (args[0] === 'image') return JSON.stringify([inspection()])
      return ''
    }
    await publishDockerImage({
      directory: f.directory,
      source,
      version,
      repository,
      findExisting: async () => existing,
      run
    })
    assert.equal(
      calls.some((args) => args[0] === 'push' && args[1] === `${repository}:${version}`),
      existing === null
    )
    assert.ok(calls.some((args) => args[0] === 'push' && args[1] === `${repository}:latest`))
    if (existing)
      assert.ok(
        calls.some((args) => args[0] === 'pull' && args.includes(`${repository}@${digest}`))
      )
  }
})

test('已有固定版本内容不同或无法确认远端状态时不推送', async (t) => {
  const f = await fixture(t)
  await writeFile(join(f.directory, dockerAssets.archive), 'verified')
  await stageDockerImage({ ...f, source, version, imageId })
  const calls = []
  const run = (args) => {
    calls.push(args)
    if (args[0] === 'image')
      return JSON.stringify([
        inspection(args.includes(`${repository}@${digest}`) ? `sha256:${'e'.repeat(64)}` : imageId)
      ])
    return ''
  }
  await assert.rejects(
    publishDockerImage({
      directory: f.directory,
      source,
      version,
      repository,
      findExisting: async () => digest,
      run
    }),
    /不同/
  )
  await assert.rejects(
    publishDockerImage({
      directory: f.directory,
      source,
      version,
      repository,
      findExisting: async () => {
        throw Error('GHCR不可用')
      },
      run
    }),
    /GHCR/
  )
  assert.ok(calls.every((args) => args[0] !== 'push'))
})

test('Docker构建通过Actions恢复制品，不再需要写入Release草稿', async () => {
  const main = await readWorkflow('release-main')
  const workflow = await readWorkflow('release-docker')
  for (const name of ['docker-build', 'docker']) {
    const job = main.jobs[name]
    assert.equal(job.uses, './.github/workflows/release-docker.yml')
    const permissions = job.permissions ?? main.permissions
    assert.equal(permissions.actions, 'read', `${name} 缺少 actions: read`)
    assert.equal(permissions.packages, 'write', `${name} 缺少 packages: write`)
  }
  assert.equal(workflow.jobs.build.permissions.contents, 'read')
  assert.equal(workflow.jobs.build.permissions.actions, 'read')
})

test('无隧道更新的批次仍构建镜像，正式公开要求镜像任务真实成功', async () => {
  const workflow = await readWorkflow('release-main')
  const needs = {
    prepare: {
      result: 'success',
      outputs: { docker: 'true', tunnel: 'false', published: 'false' }
    },
    assemble: { result: 'success' },
    'docker-build': { result: 'success' },
    'npm-publish': { result: 'success' },
    tunnel: { result: 'skipped' },
    docker: { result: 'success' }
  }
  assert.equal(evaluateWorkflowCondition(workflow.jobs['docker-build'].if, { needs }), true)
  assert.equal(evaluateWorkflowCondition(workflow.jobs.docker.if, { needs }), true)
  assert.equal(evaluateWorkflowCondition(workflow.jobs.publish.if, { needs }), true)
  for (const result of ['failure', 'cancelled', 'skipped']) {
    assert.equal(
      evaluateWorkflowCondition(workflow.jobs['docker-build'].if, {
        needs: { ...needs, assemble: { result } }
      }),
      false
    )
    assert.equal(
      evaluateWorkflowCondition(workflow.jobs.docker.if, {
        needs: { ...needs, 'docker-build': { result } }
      }),
      false
    )
    assert.equal(
      evaluateWorkflowCondition(workflow.jobs.publish.if, {
        needs: { ...needs, docker: { result } }
      }),
      false
    )
  }
})

test('Docker仅由main调用且所有公开发布等待镜像验收', async () => {
  const main = await readWorkflow('release-main')
  const docker = await readWorkflow('release-docker')
  const dev = await readWorkflow('release-dev')
  for (const [name, dependencies] of [
    ['docker-build', ['prepare', 'assemble']],
    ['npm-publish', ['prepare', 'assemble', 'docker-build']],
    ['publish', ['prepare', 'assemble', 'npm-publish', 'tunnel', 'docker']]
  ]) {
    for (const dependency of dependencies) assert.ok(main.jobs[name].needs.includes(dependency))
  }
  assert.ok(Object.hasOwn(docker.on, 'workflow_call'))
  assert.equal(Object.hasOwn(docker.on, 'workflow_dispatch'), false)
  assert.equal(Object.hasOwn(docker.on, 'push'), false)
  assert.ok(
    Object.values(docker.jobs).some((job) =>
      job.steps?.some((step) => step.run?.includes('l4-docker-smoke.mjs'))
    )
  )
  assert.ok(
    Object.values(dev.jobs).every((job) => job.uses !== './.github/workflows/release-docker.yml')
  )
  assert.equal(selectCiChecks(['apps/docker/Dockerfile'], false).automation, true)
  assert.equal(selectCiChecks(['apps/docker/Dockerfile'], false).web, false)
})
