import assert from 'node:assert/strict'
import { readFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { basename, join, resolve } from 'node:path'
import { gzipSync } from 'node:zlib'
import test from 'node:test'
import { parse } from 'yaml'
import {
  publishTunnelImage,
  readTunnelArchive,
  tunnelArchiveName
} from '../.github/scripts/release-tunnel.mjs'

const repository = 'ghcr.io/jetcrab/pi-desk-tunnel'
const version = '1.2.3'
const source = 'f'.repeat(40)
const digest = (letter) => `sha256:${letter.repeat(64)}`
const indexDigest = digest('e')
const architectures = ['amd64', 'arm64']
const imageConfig = (architecture) => ({
  os: 'linux',
  architecture,
  config: { Labels: { 'org.opencontainers.image.revision': source } }
})
const configBytes = (config) => JSON.stringify(config, null, 2) + '\n'
const configDigest = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`
const configDigests = Object.fromEntries(
  architectures.map((architecture) => [
    architecture,
    configDigest(configBytes(imageConfig(architecture)))
  ])
)
const directory = 'verified-tunnel-archives'
const input = { version, source, directory }
const manifestDigests = { amd64: digest('c'), arm64: digest('d') }

function fixture(options = {}) {
  const calls = []
  let exists = options.existing ?? false
  const index = {
    schemaVersion: 2,
    manifests: architectures.map((architecture) => ({
      digest: manifestDigests[architecture],
      platform: { os: 'linux', architecture }
    }))
  }
  const images = Object.fromEntries(
    architectures.map((architecture) => [architecture, imageConfig(architecture)])
  )
  options.changeImages?.(images)
  options.changeIndex?.(index)
  const run = (command, args) => {
    calls.push([command, ...args])
    if (command === 'tar' || command === 'tar.exe') {
      const architecture = architectures.find((value) => args[1].includes(`linux-${value}.tar.gz`))
      assert.ok(architecture, `未识别的镜像归档：${args[1]}`)
      if (args.at(-1) === 'manifest.json') {
        const entries = [
          { Config: 'config.json', RepoTags: [`${repository}:${version}-${architecture}`] }
        ]
        options.changeArchiveEntries?.(entries)
        return JSON.stringify(entries)
      }
      assert.equal(args.at(-1), 'config.json')
      return configBytes(images[architecture])
    }
    if (command === 'gh') {
      if (options.registryError && !exists) throw options.registryError
      return JSON.stringify([
        exists
          ? [
              {
                name: indexDigest,
                metadata: { container: { tags: [version] } }
              }
            ]
          : []
      ])
    }
    assert.equal(command, 'docker')
    if (args[0] === 'buildx' && args[1] === 'imagetools' && args[2] === 'inspect') {
      if (args.includes('--format')) {
        const reference = args[3]
        const architecture = architectures.find((value) =>
          reference.includes(`${version}-${value}-`)
        )
        return JSON.stringify({
          digest: architecture ? manifestDigests[architecture] : indexDigest
        })
      }
      const reference = args.at(-1)
      const architecture = architectures.find((value) => reference.endsWith(manifestDigests[value]))
      if (architecture) {
        return JSON.stringify({
          schemaVersion: 2,
          config: { digest: options.wrongRemoteImage ? digest('9') : configDigests[architecture] }
        })
      }
      assert.ok(
        [
          `${repository}:${version}`,
          `${repository}:latest`,
          `${repository}@${indexDigest}`
        ].includes(reference),
        reference
      )
      return JSON.stringify(index)
    }
    if (args[0] === 'buildx' && args[1] === 'imagetools' && args[2] === 'create') {
      if (args[4] === `${repository}:${version}`) exists = true
      return ''
    }
    if (args[0] === 'tag' || args[0] === 'push') return ''
    assert.fail(`未预期命令：${command} ${args.join(' ')}`)
  }
  return { calls, run }
}

function publications(calls) {
  return calls.filter((call) => call[1] === 'push' || call[3] === 'create')
}

test('隧道两个架构在原生runner独立验收后才发布同批制品', async () => {
  const workflow = parse(
    await readFile(new URL('../.github/workflows/release-tunnel.yml', import.meta.url), 'utf8')
  )
  const { build, publish } = workflow.jobs
  assert.deepEqual(build.strategy.matrix.include, [
    { arch: 'amd64', runner: 'ubuntu-24.04' },
    { arch: 'arm64', runner: 'ubuntu-24.04-arm' }
  ])
  assert.equal(build['runs-on'], '${{ matrix.runner }}')
  assert.equal(build.strategy['fail-fast'], false)
  assert.equal(
    build.steps.find((step) => step.uses === 'actions/checkout@v4').with.ref,
    '${{ inputs.source_sha || github.sha }}'
  )
  assert.equal(
    publish.steps.find((step) => step.uses === 'actions/checkout@v4').with.ref,
    '${{ github.sha }}'
  )
  assert.equal(publish.env.SOURCE_SHA, '${{ inputs.source_sha || github.sha }}')
  assert.ok(
    build.steps.some((step) => step.run?.includes('if [[ -f apps/tunnel/docker-start.sh ]]'))
  )
  const compile = build.steps.find((step) => step.uses === 'docker/build-push-action@v6')
  assert.equal(compile.with.platforms, 'linux/${{ matrix.arch }}')
  assert.equal(compile.with.load, true)
  assert.equal(compile.with.push, false)
  assert.equal(compile.with.provenance, false)
  const verify = build.steps.findIndex((step) => step.run?.includes('check-tunnel-image.mjs'))
  const archive = build.steps.findIndex((step) => step.run?.includes('docker save'))
  assert.ok(verify > 0 && archive > verify)
  assert.ok(build.steps[verify].run.includes('$IMAGE_VERSION-$IMAGE_ARCH'))
  const upload = build.steps.find(
    (step) =>
      step.uses === 'actions/upload-artifact@v4' && step.with.name.startsWith('tunnel-image-')
  )
  assert.equal(upload.with.name, 'tunnel-image-${{ github.run_id }}-${{ matrix.arch }}')
  assert.ok(!upload.with.name.includes('run_attempt'))
  const download = publish.steps.find((step) => step.uses === 'actions/download-artifact@v4')
  assert.equal(download.with.pattern, 'tunnel-image-${{ github.run_id }}-*')
  assert.equal(download.with['merge-multiple'], true)
  assert.ok(publish.steps.some((step) => step.run?.includes('for arch in amd64 arm64')))
  assert.ok(publish.steps.some((step) => step.run === 'node .github/scripts/release-tunnel.mjs'))
  assert.ok(publish.if.includes("needs.build.result == 'success'"))
  assert.ok(publish.if.includes("github.ref == 'refs/heads/main'"))
})

test('首次发布使用已验收的两个镜像摘要，核对完整索引后更新latest', () => {
  const { run, calls } = fixture()
  publishTunnelImage(input, run)
  const pushes = calls.filter((call) => call[1] === 'push')
  assert.equal(pushes.length, 2)
  const creates = calls.filter((call) => call[3] === 'create')
  assert.deepEqual(creates[0], [
    'docker',
    'buildx',
    'imagetools',
    'create',
    '--tag',
    `${repository}:${version}`,
    `${repository}@${manifestDigests.amd64}`,
    `${repository}@${manifestDigests.arm64}`
  ])
  assert.deepEqual(creates[1], [
    'docker',
    'buildx',
    'imagetools',
    'create',
    '--tag',
    `${repository}:latest`,
    `${repository}@${indexDigest}`
  ])
  assert.ok(calls.some((call) => call.at(-1) === `${repository}:latest` && call.includes('--raw')))
})

test('固定版本相同则复用索引，不重推或覆盖固定版本', () => {
  const { run, calls } = fixture({ existing: true })
  publishTunnelImage(input, run)
  assert.deepEqual(publications(calls), [
    [
      'docker',
      'buildx',
      'imagetools',
      'create',
      '--tag',
      `${repository}:latest`,
      `${repository}@${indexDigest}`
    ]
  ])
})

test('索引架构顺序与ARM64的v8变体不影响同一制品复用', () => {
  const { run, calls } = fixture({
    existing: true,
    changeIndex: (index) => {
      index.manifests[1].platform.variant = 'v8'
      index.manifests.reverse()
    }
  })
  publishTunnelImage(input, run)
  assert.equal(publications(calls).length, 1)
  assert.ok(!calls.some((call) => call[1] === 'push'))
})

test('远端固定版本任一架构内容不同就停止且不更新latest', () => {
  const { run, calls } = fixture({ existing: true, wrongRemoteImage: true })
  assert.throws(() => publishTunnelImage(input, run), /远端镜像.*不同/)
  assert.deepEqual(publications(calls), [])
})

test('缺失、重复或多出的架构不能作为完整多架构制品发布', () => {
  for (const changeIndex of [
    (index) => index.manifests.pop(),
    (index) => {
      index.manifests[1].platform.architecture = 'amd64'
    },
    (index) => {
      index.manifests[1].platform.architecture = 'arm'
    },
    (index) => {
      index.manifests[1].platform.os = 'windows'
    }
  ]) {
    const { run, calls } = fixture({ existing: true, changeIndex })
    assert.throws(() => publishTunnelImage(input, run))
    assert.deepEqual(publications(calls), [])
  }
})

test('两个本地制品都核对源码和架构后才允许任何推送', () => {
  for (const changeImages of [
    (images) => {
      images.arm64.config.Labels['org.opencontainers.image.revision'] = '0'.repeat(40)
    },
    (images) => {
      images.arm64.architecture = 'amd64'
    },
    (images) => {
      images.amd64.os = 'windows'
    }
  ]) {
    const { run, calls } = fixture({ changeImages })
    assert.throws(() => publishTunnelImage(input, run))
    assert.deepEqual(publications(calls), [])
  }
})

test('仓库查询认证或网络失败不能误判为首次发布', () => {
  const error = Object.assign(new Error('registry failed'), { stderr: 'HTTP 403 Forbidden' })
  const { run, calls } = fixture({ registryError: error })
  assert.throws(() => publishTunnelImage(input, run), /无法确认.*版本状态/)
  assert.deepEqual(publications(calls), [])
})

test('首次上传后内容不同会阻断固定版本和latest发布', () => {
  const { run, calls } = fixture({ wrongRemoteImage: true })
  assert.throws(() => publishTunnelImage(input, run), /已推送镜像与验收制品不同/)
  assert.equal(calls.filter((call) => call[3] === 'create').length, 0)
})

test('归档版本或架构标签错误以及多镜像归档在上传前被拒绝', () => {
  for (const changeArchiveEntries of [
    (entries) => {
      entries[0].RepoTags = [`${repository}:0.0.0-amd64`]
    },
    (entries) => {
      entries.push(entries[0])
    }
  ]) {
    const { run, calls } = fixture({ changeArchiveEntries })
    assert.throws(() => publishTunnelImage(input, run), /归档/)
    assert.deepEqual(publications(calls), [])
  }
})

async function temporaryDirectory(context) {
  const parent = resolve('temp/run/release-tunnel')
  await mkdir(parent, { recursive: true })
  const directory = await mkdtemp(join(parent, 'archive-identity-'))
  context.after(() => rm(directory, { recursive: true, force: true }))
  return directory
}

test('真实Docker归档结构保留原始config字节，不用格式化后的JSON计算摘要', async (t) => {
  const directory = await temporaryDirectory(t)
  const bytes = configBytes(imageConfig('amd64')) + '\n'
  const archive = join(directory, tunnelArchiveName(version, 'amd64'))
  await writeFile(join(directory, 'config.json'), bytes)
  await writeFile(
    join(directory, 'manifest.json'),
    JSON.stringify([{ Config: 'config.json', RepoTags: [`${repository}:${version}-amd64`] }])
  )
  execFileSync(
    process.platform === 'win32' ? 'tar.exe' : 'tar',
    ['-czf', basename(archive), 'manifest.json', 'config.json'],
    { cwd: directory }
  )
  const result = readTunnelArchive({ file: archive, version, architecture: 'amd64', source })
  assert.equal(result.configDigest, configDigest(bytes))
  assert.notEqual(result.configDigest, configDigest(bytes.trim()))
})

test(
  'Docker真实归档在隔离Registry首次发布和再次复用均通过同一config摘要',
  {
    skip: process.env.TUNNEL_DOCKER_SMOKE !== '1',
    timeout: 180_000
  },
  async (t) => {
    const directory = await temporaryDirectory(t)
    const name = `pi-desk-tunnel-registry-${randomUUID()}`
    const smokeVersion = `0.0.${process.pid}`
    const localTags = []
    const docker = (args) =>
      execFileSync('docker', args, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 60_000
      })
    t.after(() => {
      try {
        docker(['rm', '--force', name])
      } finally {
        if (localTags.length) docker(['image', 'rm', '--force', ...localTags])
      }
    })
    docker(['run', '--detach', '--name', name, '--publish', '127.0.0.1::5000', 'registry:2'])
    const address = docker(['port', name, '5000/tcp']).trim().split('\n')[0]
    const localRepository = `${address}/pi-desk-tunnel`
    const deadline = Date.now() + 20_000
    while (true) {
      const response = await fetch(`http://${address}/v2/`, {
        signal: AbortSignal.timeout(2000)
      }).catch(() => null)
      if (response?.ok) break
      assert.ok(Date.now() < deadline, '隔离Registry未就绪')
      await new Promise((resolveWait) => setTimeout(resolveWait, 100))
    }
    for (const architecture of architectures) {
      const context = join(directory, architecture)
      await mkdir(context)
      await writeFile(join(context, 'marker'), 'verified image\n')
      await writeFile(
        join(context, 'Dockerfile'),
        `FROM scratch\nCOPY marker /marker\nLABEL org.opencontainers.image.revision=${source}\n`
      )
      const tag = `${repository}:${smokeVersion}-${architecture}`
      localTags.push(tag)
      docker([
        'build',
        '--provenance=false',
        '--sbom=false',
        '--platform',
        `linux/${architecture}`,
        '--tag',
        tag,
        context
      ])
      const image = JSON.parse(docker(['image', 'inspect', tag]))[0]
      t.diagnostic(`${architecture} Docker image.Id=${image.Id}`)
      const archive = join(directory, tunnelArchiveName(smokeVersion, architecture))
      const bytes = execFileSync('docker', ['save', tag], {
        timeout: 30_000,
        maxBuffer: 8 * 1024 * 1024
      })
      await writeFile(archive, gzipSync(bytes))
      docker(['image', 'rm', tag])
      execFileSync('docker', ['load'], {
        input: bytes,
        timeout: 30_000,
        stdio: ['pipe', 'pipe', 'pipe']
      })
    }
    let published = false
    let pushes = 0
    const run = (command, args) => {
      if (command === 'gh') {
        if (!published) return '[[]]'
        const { digest } = JSON.parse(
          docker([
            'buildx',
            'imagetools',
            'inspect',
            `${localRepository}:${smokeVersion}`,
            '--format',
            '{{json .Manifest}}'
          ])
        )
        return JSON.stringify([
          [{ name: digest, metadata: { container: { tags: [smokeVersion] } } }]
        ])
      }
      if (command !== 'docker') return execFileSync(command, args, { encoding: 'utf8' })
      if (args[0] === 'tag') {
        const tag = args[2].replace(repository, localRepository)
        localTags.push(tag)
        return docker(['tag', args[1], tag])
      }
      if (args[0] === 'push') pushes++
      return docker(args.map((arg) => arg.replace(repository, localRepository)))
    }
    const input = { version: smokeVersion, source, directory }
    publishTunnelImage(input, run)
    assert.equal(pushes, 2)
    published = true
    publishTunnelImage(input, run)
    assert.equal(pushes, 2, '同一固定版本不应重新推送')
  }
)

test('镜像包尚不存在时允许首次发布', () => {
  const error = Object.assign(new Error('missing package'), { stderr: 'HTTP 404 Not Found' })
  const { run, calls } = fixture({ registryError: error })
  publishTunnelImage(input, run)
  assert.equal(calls.filter((call) => call[1] === 'push').length, 2)
})
