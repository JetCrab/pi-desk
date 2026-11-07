import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { parse } from 'yaml'
import { publishTunnelImage } from '../.github/scripts/release-tunnel.mjs'

const repository = 'ghcr.io/jetcrab/pi-desk-tunnel'
const version = '1.2.3'
const source = 'f'.repeat(40)
const digest = (letter) => `sha256:${letter.repeat(64)}`
const indexDigest = digest('e')
const architectures = ['amd64', 'arm64']
const imageIds = { amd64: digest('a'), arm64: digest('b') }
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
    architectures.map((architecture) => [
      architecture,
      {
        Id: imageIds[architecture],
        Os: 'linux',
        Architecture: architecture,
        Config: { Labels: { 'org.opencontainers.image.revision': source } }
      }
    ])
  )
  options.changeImages?.(images)
  options.changeIndex?.(index)
  const run = (command, args) => {
    calls.push([command, ...args])
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
    if (args[0] === 'image' && args[1] === 'inspect') {
      const architecture = architectures.find((value) => args[2].includes(`${version}-${value}`))
      assert.ok(architecture, `未识别的镜像：${args[2]}`)
      const image = { ...images[architecture] }
      if (args[2] !== `${repository}:${version}-${architecture}`) {
        image.RepoDigests = [`${repository}@${manifestDigests[architecture]}`]
      }
      return JSON.stringify([image])
    }
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
          config: { digest: options.wrongRemoteImage ? digest('9') : imageIds[architecture] }
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
  publishTunnelImage({ version, source }, run)
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
  publishTunnelImage({ version, source }, run)
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
  publishTunnelImage({ version, source }, run)
  assert.equal(publications(calls).length, 1)
  assert.ok(!calls.some((call) => call[1] === 'push'))
})

test('远端固定版本任一架构内容不同就停止且不更新latest', () => {
  const { run, calls } = fixture({ existing: true, wrongRemoteImage: true })
  assert.throws(() => publishTunnelImage({ version, source }, run), /远端镜像.*不同/)
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
    assert.throws(() => publishTunnelImage({ version, source }, run))
    assert.deepEqual(publications(calls), [])
  }
})

test('两个本地制品都核对源码和架构后才允许任何推送', () => {
  for (const changeImages of [
    (images) => {
      images.arm64.Config.Labels['org.opencontainers.image.revision'] = '0'.repeat(40)
    },
    (images) => {
      images.arm64.Architecture = 'amd64'
    },
    (images) => {
      images.amd64.Os = 'windows'
    }
  ]) {
    const { run, calls } = fixture({ changeImages })
    assert.throws(() => publishTunnelImage({ version, source }, run))
    assert.deepEqual(publications(calls), [])
  }
})

test('仓库查询认证或网络失败不能误判为首次发布', () => {
  const error = Object.assign(new Error('registry failed'), { stderr: 'HTTP 403 Forbidden' })
  const { run, calls } = fixture({ registryError: error })
  assert.throws(() => publishTunnelImage({ version, source }, run), /无法确认.*版本状态/)
  assert.deepEqual(publications(calls), [])
})

test('镜像包尚不存在时允许首次发布', () => {
  const error = Object.assign(new Error('missing package'), { stderr: 'HTTP 404 Not Found' })
  const { run, calls } = fixture({ registryError: error })
  publishTunnelImage({ version, source }, run)
  assert.equal(calls.filter((call) => call[1] === 'push').length, 2)
})
