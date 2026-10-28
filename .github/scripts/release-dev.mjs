import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { appendFile, copyFile, mkdir, readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readVersions, validateVersions } from './commit-versions.mjs'
import { prepareDevelopmentVersions } from './release-version-model.mjs'
import { readPublishedVersions } from './prepare-dev-release.mjs'
import { versionParts } from './npm-channel.mjs'
import { createGitHubClient } from './release-github.mjs'
import { git, latestSuccessfulRelease } from './release-plan.mjs'
import { loadReleaseRecord } from './release-metadata.mjs'
import {
  loadDevState,
  selectDevUnits,
  loadDevBatch,
  saveDevBatch,
  completeDevBatch
} from './release-dev-state.mjs'

export function developmentUnits(versions) {
  const result = {}
  for (const [name, version] of Object.entries(versions)) {
    if (name === 'desktop') {
      result.windows = version
      result.macos = version
      result.linux = version
    } else if (name !== 'website') {
      result[name] = version
    }
  }
  return result
}

export async function prepareDevBatch(
  root,
  {
    github,
    source,
    runId,
    target = 'all',
    rebuildOnly = false,
    readPublished = (name) => readPublishedVersions(name, fetch, { requireStableLatest: true })
  }
) {
  assert.match(source, /^[a-f0-9]{40}$/)
  assert.match(runId, /^\d+$/)
  assert.ok(
    ['all', 'npm', 'windows', 'macos', 'linux', 'android', 'ios', 'tunnel'].includes(target)
  )
  await validateVersions(root, { base: null, head: source })
  const state = await loadDevState(github)
  let batch = await loadDevBatch(github, runId)
  if (batch) assert.equal(batch.source, source, '开发批次固定源码不同，不能覆盖')
  const versions = developmentUnits(await readVersions(root, source))
  const latest = latestSuccessfulRelease(await github.releases())
  const stable = latest ? await loadReleaseRecord(github, latest.tag_name) : null
  const stableVersions = stable
    ? {
        ...Object.fromEntries(
          stable.packages.map((item) => [item.name.slice('@jetcrab/'.length), item.version])
        ),
        ...Object.fromEntries(stable.clients.map((item) => [item.platform, item.version])),
        tunnel: (await readVersions(root, stable.source.head)).tunnel
      }
    : {}
  if (batch && !rebuildOnly) {
    for (const id of batch.selected.filter((name) => name.startsWith('pi-desk'))) {
      const published = stableVersions[id]
      if (!published) continue
      const next = versionParts(batch.versions[id]).slice(0, 3)
      const previous = versionParts(published).slice(0, 3)
      const changed = next.findIndex((value, index) => value !== previous[index])
      assert.ok(
        changed !== -1 && next[changed] > previous[changed],
        `开发批次 ${runId} 的 ${id}@${batch.npmVersions[id]} 已被正式版 ${published} 取代；停止旧批次发布，不回退 dev 标签。请在新开发版本继续，或使用 publish=false 仅验证构建。`
      )
    }
  }
  if (state.checks === null && stable)
    await validateVersions(root, { base: stable.source.head, head: source })
  const candidates = rebuildOnly ? Object.keys(versions) : selectDevUnits(versions, state)
  const selected =
    batch?.selected ??
    candidates.filter(
      (name) =>
        (rebuildOnly || versions[name] !== stableVersions[name]) &&
        (target === 'all' || (target === 'npm' ? name.startsWith('pi-desk') : name === target))
    )
  const fixedVersions = { ...batch?.npmVersions }
  if (rebuildOnly) {
    for (const name of selected.filter((name) => name.startsWith('pi-desk'))) {
      fixedVersions[name] ??= `${versions[name]}-dev`
    }
  }
  if (!batch && selected.some((name) => name.startsWith('pi-desk'))) {
    const batches = new Map()
    for (const [name, unit] of Object.entries(state.units)) {
      if (
        !name.startsWith('pi-desk') ||
        selected.includes(name) ||
        unit.version !== versions[name] ||
        unit.version === stableVersions[name]
      )
        continue
      if (!batches.has(unit.runId)) batches.set(unit.runId, await loadDevBatch(github, unit.runId))
      const previous = batches.get(unit.runId)
      assert.ok(previous?.npmVersions[name], `缺少已成功开发依赖的固定版本：${name}`)
      fixedVersions[name] = previous.npmVersions[name]
    }
  }
  const publishedVersions = new Map(
    await Promise.all(
      (rebuildOnly ? [] : selected.filter((name) => name.startsWith('pi-desk'))).map(async (id) => {
        const name = `@jetcrab/${id}`
        return [name, await readPublished(name)]
      })
    )
  )
  const prepared = await prepareDevelopmentVersions(root, {
    before: state.checks ?? '0'.repeat(40),
    // 手动仅构建不会发布，允许验证当前稳定基础号；发布仍保留原版本门禁。
    stableBase: rebuildOnly ? null : (stable?.source.head ?? null),
    selected: selected.filter((name) => name.startsWith('pi-desk')),
    versions: fixedVersions,
    readVersions: async (name) => publishedVersions.get(name)
  })
  if (!batch) {
    batch = {
      runId,
      source,
      versions,
      selected,
      npmVersions: {
        ...fixedVersions,
        ...Object.fromEntries(
          prepared.packages
            .filter((item) => prepared.selected.includes(item.name.slice('@jetcrab/'.length)))
            .map((item) => [item.name.slice('@jetcrab/'.length), item.version])
        )
      }
    }
    await saveDevBatch(github, batch)
  }
  return { batch, checkBase: state.checks, prepared }
}

export function nativeCheckTargets(paths) {
  const changed = paths.filter((path) => !path.endsWith('.md'))
  return {
    desktop_checks: changed.some(
      (path) =>
        path.startsWith('apps/desktop/') ||
        path.startsWith('src/client/l4_foundation/desktop-window/') ||
        path === '.github/scripts/check-desktop-tunnel.mjs'
    ),
    android_checks: changed.some((path) => path.startsWith('apps/android/')),
    tunnel_checks: changed.some((path) => path.startsWith('apps/tunnel/'))
  }
}

async function main() {
  assert.equal(process.env.GITHUB_ACTIONS, 'true')
  assert.equal(process.env.GITHUB_REF, 'refs/heads/dev')
  const github = createGitHubClient({
    repository: process.env.GITHUB_REPOSITORY,
    token: process.env.GH_TOKEN
  })
  const root = resolve(import.meta.dirname, '../..')
  const runId = process.env.GITHUB_RUN_ID
  if (process.argv[2] === 'complete') {
    const batch = await loadDevBatch(github, runId)
    const results = JSON.parse(process.env.RESULTS)
    let published = []
    if (process.env.NPM_PUBLISHED_FILE) {
      try {
        published = JSON.parse(await readFile(process.env.NPM_PUBLISHED_FILE, 'utf8'))
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
        console.info(`本批没有逐包发布结果：${process.env.NPM_PUBLISHED_FILE}`)
      }
    }
    if (batch && results.plan.result === 'success') {
      await completeDevBatch(
        github,
        batch,
        Object.fromEntries(Object.entries(results).map(([name, task]) => [name, task.result])),
        published
      )
    }
    await appendFile(
      process.env.GITHUB_STEP_SUMMARY,
      `## 开发批次 ${process.env.GITHUB_SHA}\n\n` +
        Object.entries(results)
          .map(([name, task]) => `- ${name}: ${task.result}`)
          .join('\n') +
        '\n'
    )
    assert.ok(
      !Object.values(results).some((task) => ['failure', 'cancelled'].includes(task.result)),
      '开发批次有任务未通过；失败组件的成功版本保持不变'
    )
    return
  }
  assert.equal(process.argv[2], 'prepare')
  const source = process.env.GITHUB_SHA
  const before = process.env.RELEASE_BEFORE
  if (before && !/^0+$/.test(before)) await validateVersions(root, { base: before, head: source })
  const { batch, checkBase, prepared } = await prepareDevBatch(root, {
    github,
    source,
    runId,
    target: process.env.REQUESTED_TARGET || 'all',
    rebuildOnly: process.env.REBUILD_ONLY === 'true'
  })
  if (prepared.selected.length) {
    execFileSync(
      process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
      ['install', '--lockfile-only', '--ignore-scripts', '--registry=https://registry.npmjs.org'],
      { cwd: root, stdio: 'inherit' }
    )
    for (const file of [...prepared.changedFiles, 'pnpm-lock.yaml']) {
      const destination = join(resolve(process.env.DEV_MANIFEST_DIR), file)
      await mkdir(dirname(destination), { recursive: true })
      await copyFile(join(root, file), destination)
    }
  }
  const paths = git(
    root,
    ...(checkBase
      ? ['diff', '--name-only', '--no-renames', checkBase, source]
      : ['ls-tree', '-r', '--name-only', source])
  )
    .split('\n')
    .filter(Boolean)
  const outputs = {
    packages: JSON.stringify(prepared.selected),
    check_base: checkBase ?? '0'.repeat(40),
    ...Object.fromEntries(
      ['windows', 'macos', 'linux', 'android', 'ios', 'tunnel'].map((name) => [
        name,
        batch.selected.includes(name)
      ])
    ),
    ...nativeCheckTargets(paths)
  }
  for (const [name, value] of Object.entries(outputs))
    await appendFile(process.env.GITHUB_OUTPUT, `${name}=${value}\n`)
  console.info(`开发待完成单元：${batch.selected.join('、') || '无'}；成功记录未完成前不会跳过。`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}
