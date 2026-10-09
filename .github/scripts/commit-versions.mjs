import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { versionParts } from './npm-channel.mjs'
import { planVersionChanges } from './release-version-model.mjs'

function git(root, ...args) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe']
  })
}

function snapshot(root, ref) {
  const revision = ref === ':' ? ':' : git(root, 'rev-parse', '--verify', `${ref}^{commit}`).trim()
  const files = (
    ref === ':'
      ? git(root, 'ls-files', '-z')
      : git(root, 'ls-tree', '-r', '--name-only', '-z', revision)
  )
    .split('\0')
    .filter(Boolean)
  const paths = new Set(files)
  return {
    files,
    read: (file) =>
      paths.has(file) ? git(root, 'show', `${revision === ':' ? '' : revision}:${file}`) : null
  }
}

const nativeManifests = [
  'apps/desktop/package.json',
  'apps/desktop/src-tauri/tauri.conf.json',
  'apps/desktop/src-tauri/Cargo.toml',
  'apps/desktop/src-tauri/Cargo.lock',
  'apps/android/app/build.gradle.kts',
  'apps/ios/project.yml',
  'apps/tunnel/server/Cargo.toml',
  'apps/tunnel/Cargo.lock',
  'apps/website/package.json',
  'pnpm-lock.yaml',
  'apps/website/pnpm-lock.yaml'
]
const groups = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']

function manifests(files) {
  return [
    ...new Set([
      ...nativeManifests,
      ...files.filter(
        (file) => file === 'package.json' || /^plugins\/[^/]+\/package\.json$/.test(file)
      )
    ])
  ]
}

function ensureStagedManifests(root, files) {
  const dirty = git(root, 'diff', '--name-only', '-z', '--', ...manifests(files))
    .split('\0')
    .filter(Boolean)
  assert.equal(dirty.length, 0, `版本清单存在未暂存变更，请先完整暂存或恢复：${dirty.join('、')}`)
}

/** 返回指定 Git 快照中的版本，':' 表示暂存区。 */
export function readVersions(root, ref = 'HEAD') {
  const tree = snapshot(resolve(root), ref)
  const versions = {}
  for (const file of tree.files.filter(
    (file) => file === 'package.json' || /^plugins\/[^/]+\/package\.json$/.test(file)
  )) {
    const manifest = JSON.parse(tree.read(file))
    if (/^@jetcrab\/pi-desk(?:-[a-z0-9-]+)?$/.test(manifest.name) && manifest.private !== true)
      versions[manifest.name.slice('@jetcrab/'.length)] = manifest.version
  }
  for (const [id, file] of [
    ['desktop', 'apps/desktop/package.json'],
    ['website', 'apps/website/package.json']
  ]) {
    const text = tree.read(file)
    if (text !== null) versions[id] = JSON.parse(text).version
  }
  const android = tree.read('apps/android/app/build.gradle.kts')
  if (android !== null) versions.android = android.match(/^\s*versionName\s*=\s*"([^"]+)"/m)?.[1]
  const ios = tree.read('apps/ios/project.yml')
  if (ios !== null)
    versions.ios = ios.match(/^\s*MARKETING_VERSION:\s*['"]?([\d.]+)['"]?\s*$/m)?.[1]
  const tunnel = tree.read('apps/tunnel/server/Cargo.toml')
  if (tunnel !== null)
    versions.tunnel = tunnel.match(/^\[package\][\s\S]*?^version\s*=\s*"([^"]+)"/m)?.[1]
  for (const [id, version] of Object.entries(versions)) {
    versionParts(version)
    // 历史官网清单曾使用开发后缀；只归一化比较值，当前清单由 validateVersions 检查。
    versions[id] = version.replace(/-dev(?:\.\d+)?$/, '')
  }
  return versions
}

function compare(left, right) {
  const a = versionParts(left)
  const b = versionParts(right)
  for (let index = 0; index < 3; index++) {
    if (a[index] !== b[index]) return Math.sign(a[index] - b[index])
  }
  return 0
}

// pnpm workspace 链接无需重新解析；只同步被改写的显式自有依赖 specifier。
function syncLock(tree, plan) {
  const file = 'pnpm-lock.yaml'
  const original = tree.read(file)
  if (original === null) return
  const updates = new Map()
  for (const entry of plan.entries) {
    const old = JSON.parse(entry.original)
    for (const group of groups) {
      for (const [name, range] of Object.entries(entry.manifest[group] ?? {})) {
        const target = plan.entries.find((candidate) => candidate.manifest.name === name)
        const retarget =
          target &&
          (target.manifest.version !== target.currentVersion ||
            (target.previous && target.manifest.version !== target.previous.version))
        if (range !== old[group]?.[name] || retarget) {
          const importer =
            entry.file === 'package.json' ? '.' : entry.file.slice(0, -'/package.json'.length)
          updates.set(`${importer}\0${group}\0${name}`, range)
        }
      }
    }
  }
  if (!updates.size) return
  let section, importer, group, name
  const content = original
    .split('\n')
    .map((line) => {
      const top = /^(\w+):/.exec(line)
      if (top) section = top[1]
      if (section !== 'importers') return line
      const header = /^ {2}(\S.*):(?: \{\})?$/.exec(line)
      if (header) importer = header[1].replace(/^(['"])(.*)\1$/, '$2')
      const dependencyGroup = /^ {4}(\w+):/.exec(line)
      if (dependencyGroup) group = dependencyGroup[1]
      const dependency = /^ {6}(\S.*):$/.exec(line)
      if (dependency) name = dependency[1].replace(/^(['"])(.*)\1$/, '$2')
      const range = updates.get(`${importer}\0${group}\0${name}`)
      return range !== undefined && /^ {8}specifier:/.test(line)
        ? `        specifier: ${range}`
        : line
    })
    .join('\n')
  if (content !== original) plan.changes.push({ file, original, content })
}

async function applyAndStage(root, changes) {
  if (!changes.length) return []
  const indexLocation = git(root, 'rev-parse', '--git-path', 'index').trim()
  const indexPath = isAbsolute(indexLocation) ? indexLocation : join(root, indexLocation)
  const originalIndex = await readFile(indexPath)
  const originals = await Promise.all(changes.map((change) => readFile(join(root, change.file))))
  try {
    for (const change of changes) await writeFile(join(root, change.file), change.content)
    git(root, 'add', '--', ...changes.map((change) => change.file))
  } catch (error) {
    await Promise.all(
      changes.map((change, index) => writeFile(join(root, change.file), originals[index]))
    )
    await writeFile(indexPath, originalIndex)
    throw new Error('版本准备失败，已恢复版本清单和暂存区', { cause: error })
  }
  return changes.map((change) => change.file)
}

export async function prepareCommitVersions(root, options = {}) {
  root = resolve(root)
  const branch = git(root, 'rev-parse', '--abbrev-ref', 'HEAD').trim()
  const mergeHead = git(root, 'rev-parse', '--git-path', 'MERGE_HEAD').trim()
  const merging = await readFile(isAbsolute(mergeHead) ? mergeHead : join(root, mergeHead)).then(
    () => true,
    (error) => {
      if (error.code === 'ENOENT') return false
      throw error
    }
  )
  if (branch === 'main' || merging) return { changedFiles: [], selected: [] }
  const base = snapshot(root, options.base ?? 'HEAD')
  const tree = snapshot(root, ':')
  ensureStagedManifests(root, tree.files)
  const changed = new Set(
    git(root, 'diff', '--cached', '--no-renames', '--name-only', '-z', options.base ?? 'HEAD', '--')
      .split('\0')
      .filter(Boolean)
  )
  if (!changed.size) return { changedFiles: [], selected: [] }
  const plan = await planVersionChanges(root, { read: base.read, changed }, tree)
  const previous = readVersions(root, options.base ?? 'HEAD')
  const current = readVersions(root, ':')
  for (const [id, version] of Object.entries(current))
    assert.ok(!previous[id] || compare(version, previous[id]) >= 0, `${id} 版本不得回退`)
  syncLock(tree, plan)
  const changedFiles = await applyAndStage(root, plan.changes)
  return { changedFiles, selected: plan.selected }
}

export async function validateVersions(root, { base, head }) {
  root = resolve(root)
  head = git(root, 'rev-parse', '--verify', `${head}^{commit}`).trim()
  if (base !== null) base = git(root, 'rev-parse', '--verify', `${base}^{commit}`).trim()
  const tree = snapshot(root, head)
  const previous = base === null ? tree : snapshot(root, base)
  const changed = new Set(
    base === null
      ? []
      : git(root, 'diff', '--no-renames', '--name-only', '-z', base, head, '--')
          .split('\0')
          .filter(Boolean)
  )
  const plan = await planVersionChanges(root, { read: previous.read, changed }, tree)
  const before = base === null ? {} : readVersions(root, base)
  const after = readVersions(root, head)
  for (const [id, version] of Object.entries(after)) {
    assert.ok(!before[id] || compare(version, before[id]) >= 0, `${id} 版本不得回退`)
    if (plan.affected.includes(id))
      assert.ok(!before[id] || compare(version, before[id]) > 0, `${id} 制品内容变化但版本未递增`)
  }
  syncLock(tree, plan)
  assert.equal(
    plan.changes.length,
    0,
    `版本或依赖清单未同步：${plan.changes.map((entry) => entry.file).join('、')}`
  )
  return { versions: after, affected: plan.affected }
}

export async function chooseReleaseVersions(root, { targets, mode }) {
  root = resolve(root)
  assert.ok(['current', 'minor', 'patch'].includes(mode), '版本选择必须为 current、minor 或 patch')
  assert.ok(Array.isArray(targets) && targets.length > 0, '请指定发布单元')
  const tree = snapshot(root, ':')
  ensureStagedManifests(root, tree.files)
  const versions = readVersions(root, ':')
  for (const id of targets) assert.ok(id in versions, `未知发布单元：${id}`)
  const plan = await planVersionChanges(
    root,
    { read: tree.read, changed: new Set() },
    { ...tree, targets, mode }
  )
  syncLock(tree, plan)
  const changedFiles = await applyAndStage(root, plan.changes)
  return { changedFiles, selected: plan.selected, versions: readVersions(root, ':') }
}

async function main() {
  const [command, ...args] = process.argv.slice(2)
  const root = resolve(import.meta.dirname, '../..')
  let result
  if (command === 'prepare' && args.length <= 1)
    result = await prepareCommitVersions(root, args[0] ? { base: args[0] } : {})
  else if (command === 'check' && args.length === 2)
    result = await validateVersions(root, {
      base: args[0] === 'null' ? null : args[0],
      head: args[1]
    })
  else if (command === 'release' && args.length === 2)
    result = await chooseReleaseVersions(root, { mode: args[0], targets: args[1].split(',') })
  else
    throw new Error(
      '用法：commit-versions.mjs prepare [迁移基线SHA] | check <base> <head> | release <current|minor|patch> <单元ID,单元ID>'
    )
  console.info(JSON.stringify(result))
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`版本检查失败：${error.message}`)
    process.exitCode = 1
  })
}
