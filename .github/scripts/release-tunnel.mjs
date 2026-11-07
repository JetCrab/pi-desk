import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const repository = 'ghcr.io/jetcrab/pi-desk-tunnel'
const architectures = ['amd64', 'arm64']
const digestPattern = /^sha256:[a-f0-9]{64}$/

function execute(command, args) {
  const stream = command === 'docker' && (args[0] === 'push' || args[2] === 'create')
  const output = execFileSync(command, args, {
    encoding: 'utf8',
    stdio: stream ? ['ignore', 'inherit', 'inherit'] : ['ignore', 'pipe', 'pipe'],
    maxBuffer: 8 * 1024 * 1024,
    timeout: 180_000
  })
  return (output ?? '').trim()
}

function manifest(reference, run) {
  return JSON.parse(run('docker', ['buildx', 'imagetools', 'inspect', '--raw', reference]))
}

function manifestDigest(reference, run) {
  const { digest } = JSON.parse(
    run('docker', ['buildx', 'imagetools', 'inspect', reference, '--format', '{{json .Manifest}}'])
  )
  assert.match(digest, digestPattern, '镜像仓库未返回有效摘要')
  return digest
}

function assertIndex(reference, images, run) {
  const index = manifest(reference, run)
  assert.equal(index.manifests?.length, architectures.length, '镜像必须同时包含两个已验证架构')
  const platforms = new Set()
  for (const entry of index.manifests) {
    const { os, architecture } = entry.platform ?? {}
    assert.equal(os, 'linux', '容器系统与已验证制品不同')
    assert.ok(architectures.includes(architecture), '镜像包含未验证架构')
    assert.ok(!platforms.has(architecture), '镜像架构重复')
    platforms.add(architecture)
    assert.match(entry.digest, digestPattern)
    const image = manifest(`${repository}@${entry.digest}`, run)
    assert.equal(
      image.config?.digest,
      images.get(architecture).Id,
      '远端镜像与已验证制品不同，拒绝覆盖'
    )
  }
}

function findExisting(version, run) {
  let pages
  try {
    pages = JSON.parse(
      run('gh', [
        'api',
        '--paginate',
        '--slurp',
        'users/JetCrab/packages/container/pi-desk-tunnel/versions?per_page=100'
      ])
    )
  } catch (error) {
    if (/HTTP 404/.test(`${error.stderr ?? ''}`)) return null
    throw new Error('无法确认隧道镜像版本状态，停止发布', { cause: error })
  }
  const digests = new Set(
    pages
      .flat()
      .filter((entry) => entry.metadata?.container?.tags?.includes(version))
      .map((entry) => entry.name)
  )
  assert.ok(digests.size <= 1, '同一固定版本对应多个镜像摘要')
  const digest = [...digests][0] ?? null
  if (digest) assert.match(digest, digestPattern)
  return digest
}

export function publishTunnelImage({ version, source }, run = execute) {
  assert.match(version, /^\d+\.\d+\.\d+$/)
  assert.match(source, /^[a-f0-9]{40}$/)
  const images = new Map()
  for (const architecture of architectures) {
    const [image] = JSON.parse(
      run('docker', ['image', 'inspect', `${repository}:${version}-${architecture}`])
    )
    assert.equal(image.Os, 'linux', '已验证镜像不是 Linux 容器')
    assert.equal(image.Architecture, architecture, '已验证镜像架构不匹配')
    assert.equal(
      image.Config?.Labels?.['org.opencontainers.image.revision'],
      source,
      '已验证镜像源码不匹配'
    )
    assert.match(image.Id, digestPattern)
    images.set(architecture, image)
  }

  let digest = findExisting(version, run)
  if (digest) {
    assertIndex(`${repository}@${digest}`, images, run)
    console.info('已有固定版本与两个已验证架构一致，复用原镜像。')
  } else {
    const references = []
    for (const [architecture, image] of images) {
      const tag = `${repository}:${version}-${architecture}-${image.Id.slice(7, 19)}`
      run('docker', ['tag', `${repository}:${version}-${architecture}`, tag])
      console.info(`推送已验证的 ${architecture} 镜像。`)
      run('docker', ['push', tag])
      const reference = `${repository}@${manifestDigest(tag, run)}`
      assert.equal(manifest(reference, run).config?.digest, image.Id, '已推送镜像与验收制品不同')
      references.push(reference)
    }
    run('docker', [
      'buildx',
      'imagetools',
      'create',
      '--tag',
      `${repository}:${version}`,
      ...references
    ])
    assertIndex(`${repository}:${version}`, images, run)
    digest = manifestDigest(`${repository}:${version}`, run)
    assertIndex(`${repository}@${digest}`, images, run)
  }
  run('docker', [
    'buildx',
    'imagetools',
    'create',
    '--tag',
    `${repository}:latest`,
    `${repository}@${digest}`
  ])
  assertIndex(`${repository}:latest`, images, run)
  console.info('隧道多架构镜像发布完成。')
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  publishTunnelImage({ version: process.env.IMAGE_VERSION, source: process.env.SOURCE_SHA })
}
