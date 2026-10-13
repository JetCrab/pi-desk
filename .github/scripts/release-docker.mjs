import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { appendFile, cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createGitHubClient, sha256 } from './release-github.mjs'

export const dockerAssets = {
  archive: 'pi-desk-docker.tar.gz',
  record: 'docker-image.json'
}
const imageRepository = 'ghcr.io/jetcrab/pi-desk'
const stable = /^\d+\.\d+\.\d+$/
const digestPattern = /^sha256:[a-f0-9]{64}$/
const json = (value) => JSON.stringify(value, null, 2) + '\n'
const docker = (args) =>
  execFileSync('docker', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    maxBuffer: 8 * 1024 * 1024
  }).trim()

export function dockerInstallManifests(host, sdk) {
  assert.equal(host.name, '@jetcrab/pi-desk')
  assert.equal(sdk.name, '@jetcrab/pi-desk-sdk')
  assert.match(host.version, stable)
  assert.match(sdk.version, stable)
  const pi = host.devDependencies['@earendil-works/pi-coding-agent']
  assert.match(pi, stable)
  return {
    host: {
      private: true,
      dependencies: {
        '@jetcrab/pi-desk': 'file:host.tgz',
        '@jetcrab/pi-desk-sdk': 'file:sdk.tgz'
      }
    },
    pi: { private: true, dependencies: { '@earendil-works/pi-coding-agent': pi } }
  }
}

function assertImage(image, source, version, imageId) {
  assert.equal(
    image.Config.Labels['org.opencontainers.image.revision'],
    source,
    '镜像源码与本批不同'
  )
  assert.equal(
    image.Config.Labels['org.opencontainers.image.version'],
    version,
    '镜像版本与本批不同'
  )
  assert.match(image.Id, digestPattern)
  if (imageId) assert.equal(image.Id, imageId, '已发布固定版本与已验证镜像不同，拒绝覆盖')
  return image.Id
}

function assertRecord(record, source, version, bytes) {
  assert.match(source, /^[a-f0-9]{40}$/)
  assert.match(version, stable)
  assert.equal(record.source, source, '镜像记录属于不同源码批次')
  assert.equal(record.version, version, '镜像记录属于不同版本')
  assert.match(record.imageId, digestPattern)
  assert.equal(record.sha256, sha256(bytes), '镜像压缩文件摘要不匹配')
  return record
}

export async function stageDockerImage({ directory, source, version, imageId }) {
  assert.match(source, /^[a-f0-9]{40}$/)
  assert.match(version, stable)
  assert.match(imageId, digestPattern)
  const bytes = await readFile(join(directory, dockerAssets.archive))
  const record = { source, version, imageId, sha256: sha256(bytes) }
  await writeFile(join(directory, dockerAssets.record), json(record))
}

export async function restoreDockerImage({ directory, source, version }) {
  const archive = join(directory, dockerAssets.archive)
  const record = join(directory, dockerAssets.record)
  const archiveExists = existsSync(archive)
  const recordExists = existsSync(record)
  if (!archiveExists && !recordExists) return false
  assert.ok(archiveExists, '镜像记录存在但缺少已验证镜像，停止重建')
  assert.ok(recordExists, '已验证镜像缺少记录，归档不完整，停止重建')
  assertRecord(JSON.parse(await readFile(record)), source, version, await readFile(archive))
  console.info('已恢复同批已验证镜像，不重复构建。')
  return true
}

export async function publishDockerImage({
  directory,
  source,
  version,
  repository = imageRepository,
  findExisting,
  run = docker
}) {
  const archive = join(directory, dockerAssets.archive)
  const record = assertRecord(
    JSON.parse(await readFile(join(directory, dockerAssets.record))),
    source,
    version,
    await readFile(archive)
  )
  run(['load', '--input', archive])
  assertImage(
    JSON.parse(run(['image', 'inspect', `${repository}:${version}`]))[0],
    source,
    version,
    record.imageId
  )
  const existing = await findExisting(version)
  let target = `${repository}:${version}`
  if (existing) {
    assert.match(existing, digestPattern)
    target = `${repository}@${existing}`
    run(['pull', '--platform', 'linux/amd64', target])
    assertImage(JSON.parse(run(['image', 'inspect', target]))[0], source, version, record.imageId)
    console.info(`固定版本 ${version} 已存在且内容一致，复用原镜像。`)
  } else {
    run(['push', target])
  }
  run(['tag', target, `${repository}:latest`])
  run(['push', `${repository}:latest`])
}

async function findPublishedVersion(version) {
  const matches = new Set()
  for (let page = 1; ; page++) {
    const response = await fetch(
      `https://api.github.com/users/JetCrab/packages/container/pi-desk/versions?per_page=100&page=${page}`,
      {
        headers: {
          authorization: `Bearer ${process.env.GH_TOKEN}`,
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28'
        },
        signal: AbortSignal.timeout(30000)
      }
    )
    if (response.status === 404 && page === 1) return null
    assert.ok(response.ok, `无法确认 GHCR 版本状态：HTTP ${response.status}`)
    const entries = await response.json()
    for (const entry of entries) {
      if (entry.metadata?.container?.tags?.includes(version)) matches.add(entry.name)
    }
    if (entries.length < 100) break
  }
  assert.ok(matches.size <= 1, '同一镜像版本对应多个摘要')
  return [...matches][0] ?? null
}

async function verifyPublicPull(version) {
  const response = await fetch(
    'https://ghcr.io/token?service=ghcr.io&scope=repository:jetcrab/pi-desk:pull',
    { signal: AbortSignal.timeout(30000) }
  )
  assert.ok(response.ok, '镜像尚未允许匿名拉取；请确认 GHCR 包的公开设置后重试，流程不会修改可见性')
  const { token } = await response.json()
  for (const tag of [version, 'latest']) {
    const manifest = await fetch(`https://ghcr.io/v2/jetcrab/pi-desk/manifests/${tag}`, {
      method: 'HEAD',
      headers: {
        authorization: `Bearer ${token}`,
        accept:
          'application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json'
      },
      signal: AbortSignal.timeout(30000)
    })
    assert.ok(manifest.ok, `镜像 ${tag} 匿名拉取检查失败：HTTP ${manifest.status}`)
  }
}

export async function prepareDockerContext(root, archives, directory, version) {
  const sdkVersion = JSON.parse(
    await readFile(join(root, 'plugins/pi-desk-sdk/package.json'))
  ).version
  const hostArchive = join(archives, `jetcrab-pi-desk-${version}.tgz`)
  const sdkArchive = join(archives, `jetcrab-pi-desk-sdk-${sdkVersion}.tgz`)
  assert.ok(existsSync(hostArchive), '缺少同批已验证主程序 npm 制品')
  if (!existsSync(sdkArchive)) {
    // SDK 未变化时只取固定正式版本，不读 latest，也不重建 SDK。
    execFileSync(
      'npm',
      [
        'pack',
        `@jetcrab/pi-desk-sdk@${sdkVersion}`,
        '--ignore-scripts',
        '--pack-destination',
        archives,
        '--registry=https://registry.npmjs.org'
      ],
      { stdio: 'inherit' }
    )
  }
  const manifest = (archive) =>
    JSON.parse(
      execFileSync('tar', ['-xOzf', archive, 'package/package.json'], {
        encoding: 'utf8',
        maxBuffer: 1024 * 1024
      })
    )
  const host = manifest(hostArchive)
  const sdk = manifest(sdkArchive)
  assert.equal(host.version, version)
  assert.equal(sdk.version, sdkVersion)
  const manifests = dockerInstallManifests(host, sdk)
  await mkdir(join(directory, 'host'), { recursive: true })
  await mkdir(join(directory, 'pi'), { recursive: true })
  await Promise.all([
    cp(hostArchive, join(directory, 'host/host.tgz')),
    cp(sdkArchive, join(directory, 'host/sdk.tgz')),
    writeFile(join(directory, 'host/package.json'), json(manifests.host)),
    writeFile(join(directory, 'pi/package.json'), json(manifests.pi)),
    ...['Dockerfile', '.dockerignore', 'prune-image.mjs'].map((name) =>
      cp(join(root, 'apps/docker', name), join(directory, name))
    )
  ])
  console.info(
    `镜像上下文已准备：主程序 ${version}，SDK ${sdkVersion}，Pi ${manifests.pi.dependencies['@earendil-works/pi-coding-agent']}`
  )
}

async function main() {
  assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Docker发布仅在GitHub Actions执行')
  assert.equal(process.env.GITHUB_REF, 'refs/heads/main', 'Docker镜像仅支持正式版')
  const root = resolve(import.meta.dirname, '../..')
  const version = JSON.parse(await readFile(join(root, 'package.json'))).version
  const source = process.env.SOURCE_SHA
  assert.match(version, stable)
  assert.match(source, /^[a-f0-9]{40}$/)
  const directory = resolve(process.env.DOCKER_ARTIFACT_DIR)
  const [command] = process.argv.slice(2)
  if (command === 'prepare') {
    await prepareDockerContext(
      root,
      resolve(process.env.NPM_ARTIFACT_DIR),
      join(directory, 'context'),
      version
    )
    return
  }
  if (command === 'publish') {
    await publishDockerImage({ directory, source, version, findExisting: findPublishedVersion })
    await verifyPublicPull(version)
    return
  }
  if (command === 'restore') {
    const repository = process.env.GITHUB_REPOSITORY
    const runId = process.env.GITHUB_RUN_ID
    assert.match(runId, /^\d+$/)
    const github = createGitHubClient({ repository, token: process.env.GH_TOKEN })
    const name = `docker-image-${runId}`
    let artifact
    for (let page = 1; ; page++) {
      const result = await github.request(
        `/actions/runs/${runId}/artifacts?per_page=100&page=${page}`
      )
      artifact = result.artifacts.find((item) => item.name === name)
      if (artifact || result.artifacts.length < 100) break
    }
    let reused = false
    if (artifact) {
      assert.equal(artifact.expired, false, '已验证镜像制品已过期，停止重建')
      console.info('正在下载当前工作流已验证镜像制品。')
      await mkdir(directory, { recursive: true })
      execFileSync(
        'gh',
        ['run', 'download', runId, '--repo', repository, '--name', name, '--dir', directory],
        { stdio: 'inherit' }
      )
      reused = await restoreDockerImage({ directory, source, version })
      assert.equal(reused, true, '已验证镜像制品缺少完整归档，停止重建')
    } else {
      console.info('当前工作流尚无已验证镜像制品，开始首次构建。')
    }
    await appendFile(process.env.GITHUB_OUTPUT, `reused=${reused}\nversion=${version}\n`)
  } else if (command === 'stage') {
    const image = JSON.parse(docker(['image', 'inspect', `${imageRepository}:${version}`]))[0]
    await stageDockerImage({
      directory,
      source,
      version,
      imageId: assertImage(image, source, version)
    })
    console.info('已生成本地镜像校验记录，等待归档工作流制品。')
  } else throw new Error('未知Docker发布阶段')
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}
