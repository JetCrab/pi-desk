import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { validateVersions } from './commit-versions.mjs'
import {
  loadDevArtifactSources,
  loadDevBatch,
  recordDevArtifactSources
} from './release-dev-state.mjs'
import { createGitHubClient } from './release-github.mjs'
import { readNpmArchiveManifest, runAsync } from './release-npm.mjs'

const registry = 'https://registry.npmjs.org'

/** @returns {Promise<boolean>} */
async function hasRunArtifact(github, runId, name) {
  let pages = 1
  for (let page = 1; page <= pages; page += 1) {
    const result = await github.request(
      `/actions/runs/${runId}/artifacts?per_page=100&page=${page}`,
      { allow404: true }
    )
    if (!result) return false
    assert.ok(Number.isSafeInteger(result.total_count) && result.total_count >= 0, '制品数量无效')
    if (page === 1) pages = Math.ceil(result.total_count / 100)
    if (result.artifacts.some((artifact) => artifact.name === name && !artifact.expired))
      return true
  }
  return false
}

/** @returns {Promise<Buffer|null>} */
async function registryArchive(id, version) {
  const name = `@jetcrab/${id}`
  const label = `${name}@${version}`
  const response = await fetch(`${registry}/${encodeURIComponent(name)}/${version}`, {
    signal: AbortSignal.timeout(30_000)
  })
  if (response.status === 404) {
    await response.body?.cancel()
    return null
  }
  assert.ok(response.ok, `Registry 固定版本查询失败：${label}，HTTP ${response.status}`)
  const metadata = await response.json()
  assert.equal(metadata.name, name, `Registry 包名不匹配：${label}`)
  assert.equal(metadata.version, version, `Registry 版本不匹配：${label}`)
  assert.ok(
    typeof metadata.dist?.tarball === 'string' && metadata.dist.tarball.startsWith(`${registry}/`),
    `Registry 未提供官方 tarball：${label}`
  )
  assert.match(
    metadata.dist.integrity,
    /^sha512-[A-Za-z0-9+/]+={0,2}$/,
    `Registry 完整性无效：${label}`
  )
  const archive = await fetch(metadata.dist.tarball, { signal: AbortSignal.timeout(30_000) })
  assert.ok(archive.ok, `Registry 原始包下载失败：${label}，HTTP ${archive.status}`)
  const bytes = Buffer.from(await archive.arrayBuffer())
  const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`
  assert.equal(integrity, metadata.dist.integrity, `Registry 原始包完整性不匹配：${label}`)
  return bytes
}

/** @returns {Promise<boolean>} */
async function restoreArchive(source, destination, id, version) {
  let bytes
  try {
    bytes = await readFile(source)
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
  const manifest = readNpmArchiveManifest(source)
  assert.equal(manifest.name, `@jetcrab/${id}`, `原始制品包名不匹配：${id}`)
  assert.equal(manifest.version, version, `原始制品版本不匹配：${id}`)
  try {
    await copyFile(source, destination, constants.COPYFILE_EXCL)
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
    assert.ok(
      bytes.equals(await readFile(destination)),
      `已存在不同内容，拒绝覆盖：${id}@${version}`
    )
  }
  return true
}

/** @returns {Promise<string[]>} */
export async function restoreDevPackages(root, { github, batch, directory, repository }) {
  assert.match(repository, /^[\w.-]+\/[\w.-]+$/)
  const sources = await loadDevArtifactSources(github)
  const batches = new Map()
  const checked = new Set()
  const groups = new Map()
  for (const id of batch.selected.filter((name) => name.startsWith('pi-desk'))) {
    const runId = sources[id]
    if (!runId) {
      console.info(`重新构建：${id}，尚无原始制品来源`)
      continue
    }
    if (!batches.has(runId)) batches.set(runId, await loadDevBatch(github, runId))
    const old = batches.get(runId)
    assert.ok(
      old?.selected.includes(id) && old.npmVersions[id],
      `原始制品来源批次无效：${id}/${runId}`
    )
    if (old.versions[id] !== batch.versions[id] || old.npmVersions[id] !== batch.npmVersions[id]) {
      console.info(`重新构建：${id}，原始制品版本与当前批次不同`)
      continue
    }
    const pair = `${old.source}:${batch.source}`
    if (!checked.has(pair)) {
      try {
        await validateVersions(root, { base: old.source, head: batch.source })
      } catch (error) {
        throw new Error(`拒绝复用 ${id}（来源运行 ${runId}）：${error.message}`, { cause: error })
      }
      checked.add(pair)
    }
    if (!groups.has(runId)) groups.set(runId, [])
    groups.get(runId).push(id)
  }
  if (!groups.size) return []
  const temporaryRoot = join(resolve(root), 'temp/package/npm-dev-reuse')
  await mkdir(temporaryRoot, { recursive: true })
  const temporary = await mkdtemp(join(temporaryRoot, `${batch.runId}-`))
  const output = resolve(directory)
  const restored = []
  try {
    await mkdir(output, { recursive: true })
    for (const [runId, ids] of groups) {
      const download = join(temporary, runId)
      const artifactName = `npm-packages-${runId}`
      await mkdir(download)
      const available = await hasRunArtifact(github, runId, artifactName)
      if (available) {
        await runAsync(
          'gh',
          ['run', 'download', runId, '--repo', repository, '-n', artifactName, '--dir', download],
          { cwd: root }
        )
      }
      for (const id of ids) {
        const version = batch.npmVersions[id]
        const filename = `jetcrab-${id}-${version}.tgz`
        const destination = join(output, filename)
        const source = join(download, filename)
        if (available && (await restoreArchive(source, destination, id, version))) {
          restored.push(id)
          console.info(`复用原始制品：${id}@${version}，来源运行 ${runId}`)
          continue
        }
        console.info(`原始制品缺失或过期：${id}，查询 Registry 固定版本 ${version}`)
        const bytes = await registryArchive(id, version)
        if (!bytes) {
          console.info(`重新构建：${id}@${version}，Registry 固定版本不存在`)
          continue
        }
        await writeFile(source, bytes)
        await restoreArchive(source, destination, id, version)
        restored.push(id)
        console.info(`复用 Registry 原始包：${id}@${version}`)
      }
    }
    return restored
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

/** @returns {Promise<void>} */
async function main() {
  assert.equal(process.env.GITHUB_ACTIONS, 'true', '制品续跑仅允许在 GitHub Actions 中执行')
  assert.equal(process.env.GITHUB_REF, 'refs/heads/dev', '制品续跑仅允许在 dev 分支执行')
  const command = process.argv[2]
  assert.ok(['restore', 'record'].includes(command), '请指定 restore 或 record')
  const repository = process.env.GITHUB_REPOSITORY
  const runId = process.env.GITHUB_RUN_ID
  const github = createGitHubClient({ repository, token: process.env.GH_TOKEN })
  const batch = await loadDevBatch(github, runId)
  assert.ok(batch, `缺少固定开发批次：${runId}`)
  if (command === 'restore') {
    assert.ok(process.env.NPM_ARTIFACT_DIR, '缺少 NPM_ARTIFACT_DIR')
    const restored = await restoreDevPackages(resolve(import.meta.dirname, '../..'), {
      github,
      batch,
      directory: process.env.NPM_ARTIFACT_DIR,
      repository
    })
    console.info(`已恢复原始 npm 制品：${restored.join('、') || '无'}`)
  } else {
    await recordDevArtifactSources(github, batch)
    console.info(`已记录上传的原始 npm 制品来源：运行 ${runId}`)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`原始制品续跑失败：${error.message}`)
    process.exitCode = 1
  })
}
