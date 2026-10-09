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
  const files = new Map()
  const release = { draft: true, target_commitish: source, assets: [] }
  const github = {
    asset: async (_release, name) => files.get(name),
    putAsset: async (_release, name, bytes) => {
      if (files.has(name)) assert.equal(sha256(files.get(name)), sha256(bytes))
      else {
        files.set(name, bytes)
        release.assets.push({ name })
      }
    }
  }
  return { directory, files, release, github }
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

test('已验证镜像上传后可按原摘要恢复，损坏或错批次禁止复用', async (t) => {
  const f = await fixture(t)
  const bytes = Buffer.from('same verified image')
  await writeFile(join(f.directory, dockerAssets.archive), bytes)
  await stageDockerImage({ ...f, source, version, imageId })
  await writeFile(join(f.directory, dockerAssets.archive), 'different rebuilt image')
  assert.equal(await restoreDockerImage({ ...f, source, version }), true)
  assert.deepEqual(await readFile(join(f.directory, dockerAssets.archive)), bytes)
  const record = JSON.parse(f.files.get(dockerAssets.record))
  assert.equal(record.sha256, sha256(bytes))
  await assert.rejects(restoreDockerImage({ ...f, source: 'd'.repeat(40), version }))
  f.files.set(dockerAssets.archive, Buffer.from('tampered'))
  await assert.rejects(restoreDockerImage({ ...f, source, version }), /摘要/)
})

test('镜像记录上传中断时仍复用先保存的压缩镜像，不覆盖原内容', async (t) => {
  const f = await fixture(t)
  const bytes = Buffer.from('verified before interrupted record upload')
  f.files.set(dockerAssets.archive, bytes)
  f.release.assets.push({ name: dockerAssets.archive })
  const calls = []
  const run = (args) => {
    calls.push(args)
    if (args[0] === 'image') return JSON.stringify([inspection()])
    return ''
  }
  assert.equal(await restoreDockerImage({ ...f, source, version, run }), true)
  assert.ok(calls.some((args) => args[0] === 'load'))
  assert.equal(JSON.parse(f.files.get(dockerAssets.record)).sha256, sha256(bytes))
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

test('Docker仅由main调用且所有公开发布等待镜像验收', async () => {
  const main = await readFile(
    new URL('../.github/workflows/release-main.yml', import.meta.url),
    'utf8'
  )
  const docker = await readFile(
    new URL('../.github/workflows/release-docker.yml', import.meta.url),
    'utf8'
  )
  const dev = await readFile(
    new URL('../.github/workflows/release-dev.yml', import.meta.url),
    'utf8'
  )
  assert.match(main, /docker-build:[\s\S]*?needs: \[prepare, assemble\]/)
  assert.match(main, /npm-publish:[\s\S]*?needs: \[prepare, assemble, docker-build\]/)
  assert.match(main, /publish:\n    needs: \[prepare, assemble, npm-publish, tunnel, docker\]/)
  assert.match(docker, /github.ref == 'refs\/heads\/main'/)
  assert.match(docker, /l4-docker-smoke\.mjs/)
  assert.doesNotMatch(docker, /next build|workflow_dispatch|branches:.*dev/)
  assert.doesNotMatch(dev, /release-docker\.yml/)
  assert.equal(selectCiChecks(['apps/docker/Dockerfile'], false).automation, true)
  assert.equal(selectCiChecks(['apps/docker/Dockerfile'], false).web, false)
})
