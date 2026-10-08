import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { versionParts } from './npm-channel.mjs'

const packageName = /^@jetcrab\/pi-desk(?:-[a-z0-9-]+)?$/
const dependencyGroups = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies'
]
const excluded =
  /(?:^|\/)(?:docs|tests?|__tests__|androidTest|testFixtures)(?:\/|$)|(?:\.test|\.spec)\.|(?:^|\/)test-[^/]+|(?:_tests|tests)\.rs$|\.(?:md|snap)$|(?:^|\/)(?:README(?:\.[^/]+)?|LICENSE(?:\.[^/]+)?|THIRD_PARTY_NOTICES[^/]*)$/i
const rootConfig =
  /^(?:next|postcss|tailwind)\.config\.[^/]+$|^tsconfig(?:\.base)?\.json$|^(?:components\.json|\.npmrc|pnpm-workspace\.yaml)$/

function git(root, ...args) {
  try {
    return execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe']
    })
  } catch {
    throw new Error('无法读取 Git 发布基线或净差异，请确认提交已检出')
  }
}

function snapshot(root, revision, head = null) {
  if (revision !== null) {
    assert.ok(
      typeof revision === 'string' && /^[a-f0-9]{40}$/i.test(revision),
      '基线必须为完整提交 SHA'
    )
    git(root, 'rev-parse', '--verify', `${revision}^{commit}`)
  }
  const files = new Set(
    revision === null
      ? []
      : git(root, 'ls-tree', '-r', '--name-only', '-z', revision).split('\0').filter(Boolean)
  )
  const changed = new Set(
    revision === null
      ? head === null
        ? []
        : git(root, 'ls-tree', '-r', '--name-only', '-z', head).split('\0').filter(Boolean)
      : git(
          root,
          'diff',
          '--no-renames',
          '--name-only',
          '-z',
          revision,
          ...(head ? [head] : []),
          '--'
        )
          .split('\0')
          .filter(Boolean)
  )
  return {
    changed,
    read: (file) => (files.has(file) ? git(root, 'show', `${revision}:${file}`) : null)
  }
}

async function readOptional(root, file) {
  try {
    return await readFile(join(root, file), 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw new Error(`无法读取版本清单：${file}`)
  }
}

function json(text, file) {
  try {
    const value = JSON.parse(text)
    assert.ok(value && typeof value === 'object' && !Array.isArray(value))
    return value
  } catch {
    throw new Error(`包清单 JSON 无效：${file}`)
  }
}

function stableVersion(version) {
  versionParts(version)
  return version.replace(/-dev\.\d+$/, '')
}

function compareVersions(left, right) {
  const a = versionParts(left)
  const b = versionParts(right)
  for (let index = 0; index < 3; index++) {
    if (a[index] !== b[index]) return Math.sign(a[index] - b[index])
  }
  return 0
}

function patch(version) {
  const parts = versionParts(version).slice(0, 3)
  parts[2]++
  const next = parts.join('.')
  versionParts(next)
  return next
}

function plannedVersion(current, previous, affected, development = false) {
  const version = stableVersion(current)
  const comparison = previous === null ? 1 : compareVersions(version, previous)
  if (development) {
    assert.ok(comparison >= 0, '版本不得回退')
    if (!affected) return current
    const next = versionParts(current)[3] !== null || comparison > 0 ? version : patch(version)
    return `${next}-dev.1`
  }
  // dev 不必回合并 Actions 的版本准备提交；正式发布以上次成功版本为下限。
  const baseline = comparison < 0 ? stableVersion(previous) : version
  return affected && comparison <= 0 ? patch(baseline) : baseline
}

function productionManifest(manifest) {
  const fields = [
    'name',
    ...dependencyGroups,
    'peerDependenciesMeta',
    'exports',
    'main',
    'module',
    'types',
    'bin',
    'files',
    'engines',
    'pi',
    'piDesk',
    'type',
    'sideEffects',
    'browser',
    'os',
    'cpu'
  ]
  const result = Object.fromEntries(
    fields.filter((key) => key in manifest).map((key) => [key, manifest[key]])
  )
  result.scripts = Object.fromEntries(
    Object.entries(manifest.scripts ?? {}).filter(
      ([name]) => !/^(?:test|lint|format|check|typecheck)(?::|$)/.test(name)
    )
  )
  return result
}

async function npmEntries(root, baseline) {
  const plugins = await readdir(join(root, 'plugins'), { withFileTypes: true })
  const files = [
    'package.json',
    ...plugins
      .filter((entry) => entry.isDirectory())
      .map((entry) => `plugins/${entry.name}/package.json`)
      .sort()
  ]
  const entries = []
  const names = new Set()
  for (const file of files) {
    const original = await readOptional(root, file)
    if (file !== 'package.json' && original === null) continue
    assert.ok(original !== null, '缺少公开主包清单')
    const manifest = json(original, file)
    const own = typeof manifest.name === 'string' && packageName.test(manifest.name)
    if (file !== 'package.json' && (!own || manifest.private === true)) continue
    assert.ok(own && manifest.private !== true, `不可公开发布的主包：${file}`)
    assert.ok(manifest.publishConfig?.registry === 'https://registry.npmjs.org', file)
    assert.ok(manifest.publishConfig?.access === 'public', file)
    assert.ok(!names.has(manifest.name), `公开包名重复：${manifest.name}`)
    names.add(manifest.name)
    const oldText = baseline.read(file)
    const previous = oldText === null ? null : json(oldText, file)
    if (previous) assert.ok(previous.name === manifest.name, `包名变化需单独确认：${file}`)
    try {
      stableVersion(manifest.version)
      if (previous) stableVersion(previous.version)
    } catch {
      throw new Error(`公开包版本无效：${file}`)
    }
    for (const group of dependencyGroups) {
      const dependencies = manifest[group]
      if (dependencies === undefined) continue
      assert.ok(
        dependencies && typeof dependencies === 'object' && !Array.isArray(dependencies),
        `${file} 的 ${group} 必须为依赖映射`
      )
      for (const [name, range] of Object.entries(dependencies)) {
        assert.ok(typeof range === 'string', `${file} 的 ${group}.${name} 必须为字符串`)
      }
    }
    const directory = dirname(file)
    const affected = [...baseline.changed].some((path) => {
      if (excluded.test(path)) return false
      if (path === file)
        return (
          !previous ||
          !isDeepStrictEqual(productionManifest(manifest), productionManifest(previous))
        )
      return directory === '.'
        ? /^(?:src|bin)\//.test(path) || rootConfig.test(path)
        : path.startsWith(`${directory}/`)
    })
    entries.push({ file, original, manifest, previous, affected, currentVersion: manifest.version })
  }
  return entries
}

function dependencyRange(range, target, development) {
  const symbolic = /^(?:workspace:)?(?:\*|[~^])$/.test(range)
  if (symbolic) return range
  const retarget =
    target.manifest.version !== target.currentVersion ||
    (target.previous !== null && target.manifest.version !== target.previous.version)
  if (!retarget && (development || !range.includes('-dev.'))) return range
  const single =
    /^(\s*(?:workspace:)?(?:[~^]|[<>]=?|=)?\s*)(\d+\.\d+\.\d+(?:-dev\.\d+)?)(\s*)$/.exec(range)
  if (single) {
    versionParts(single[2])
    return `${single[1]}${retarget ? target.manifest.version : stableVersion(single[2])}${single[3]}`
  }
  // 复合范围保留上界，仅同步原目标版本或基线版本所在的端点。
  let matched = false
  const next = range.replace(
    /(?<![\w.])\d+\.\d+\.\d+(?:-dev\.\d+)?(?![\w.+-])/g,
    (version, offset) => {
      const stable = stableVersion(version)
      const upperBound = /(?:<=?\s*|-\s*)$/.test(range.slice(0, offset))
      if (
        retarget &&
        !upperBound &&
        (stable === stableVersion(target.currentVersion) ||
          (target.previous && stable === stableVersion(target.previous.version)))
      ) {
        matched = true
        return target.manifest.version
      }
      return development ? version : stable
    }
  )
  const syntax = next.replace(/^workspace:/, '').replace(/\d+\.\d+\.\d+-dev\.\d+/g, '0.0.0')
  assert.ok(/^[\d.xX*~^<>=|\s-]+$/.test(syntax), '不支持自动同步的自有依赖范围')
  assert.ok(
    !retarget || matched || /^[xX*\d.\s]+$/.test(range),
    '自有依赖范围未引用当前或基线版本，无法自动同步'
  )
  return next
}

function planNpm(entries, { baseline, development = false, versions = new Map() }) {
  const selected = new Set()
  for (const entry of entries) {
    const previous = entry.previous?.version ?? null
    const versionChanged =
      previous !== null &&
      (development
        ? entry.currentVersion !== previous
        : compareVersions(entry.currentVersion, previous) > 0)
    const affected = entry.affected || versionChanged || (baseline !== null && previous === null)
    if (affected) selected.add(entry.manifest.name)
    entry.manifest.version = plannedVersion(entry.currentVersion, previous, affected, development)
  }
  // 自有依赖的制品版本变化会影响消费者；workspace 范围不需要改写。
  let added
  do {
    added = false
    for (const entry of entries) {
      if (selected.has(entry.manifest.name)) continue
      const affected = dependencyGroups.some((group) =>
        Object.keys(entry.manifest[group] ?? {}).some((name) => selected.has(name))
      )
      if (!affected) continue
      selected.add(entry.manifest.name)
      entry.manifest.version = plannedVersion(
        entry.currentVersion,
        entry.previous?.version ?? null,
        true,
        development
      )
      added = true
    }
  } while (added)
  for (const entry of entries) {
    if (versions.has(entry.manifest.name))
      entry.manifest.version = versions.get(entry.manifest.name)
  }
  const byName = new Map(entries.map((entry) => [entry.manifest.name, entry]))
  const changes = []
  for (const entry of entries) {
    for (const group of dependencyGroups) {
      for (const [name, range] of Object.entries(entry.manifest[group] ?? {})) {
        const target = byName.get(name)
        if (target) entry.manifest[group][name] = dependencyRange(range, target, development)
      }
    }
    if (!isDeepStrictEqual(json(entry.original, entry.file), entry.manifest)) {
      changes.push({
        file: entry.file,
        original: entry.original,
        content: `${JSON.stringify(entry.manifest, null, 2)}\n`
      })
    }
  }
  return {
    changes,
    selected: [...selected]
      .map((name) => name.slice('@jetcrab/'.length))
      .sort((a, b) => (a === 'pi-desk-sdk' ? -1 : b === 'pi-desk-sdk' ? 1 : a.localeCompare(b)))
  }
}

function rustPackage(text, file) {
  const section = /^\[package\][^\S\r\n]*\r?\n([\s\S]*?)(?=^\[|$(?![\s\S]))/m.exec(text)
  const name = section?.[1].match(/^name\s*=\s*"([^"]+)"/m)?.[1]
  const version = section?.[1].match(/^version\s*=\s*"([^"]+)"/m)?.[1]
  assert.ok(name && version, `Rust 清单缺少自有包版本：${file}`)
  assert.ok(versionParts(version)[3] === null, `原生包必须使用正式版本：${file}`)
  return { name, version, section: section[0] }
}

function rustVersion(text, file, version) {
  const { section } = rustPackage(text, file)
  return text.replace(section, section.replace(/^(version\s*=\s*")[^"]+(".*)$/m, `$1${version}$2`))
}

function lockVersion(text, name, version) {
  let count = 0
  const next = text.replace(
    /^\[\[package\]\][\s\S]*?(?=^\[\[package\]\]|$(?![\s\S]))/gm,
    (section) => {
      if (section.match(/^name\s*=\s*"([^"]+)"/m)?.[1] !== name) return section
      count++
      const current = section.match(/^version\s*=\s*"([^"]+)"/m)?.[1]
      assert.ok(current && versionParts(current)[3] === null, `锁文件自有包版本无效：${name}`)
      return section.replace(/^(version\s*=\s*")[^"]+(".*)$/m, `$1${version}$2`)
    }
  )
  assert.ok(count === 1, `锁文件必须有唯一自有包条目：${name}`)
  return next
}

export function productionContent(file, text) {
  if (text === null) return null
  if (file === 'package.json' || file.endsWith('/package.json'))
    return productionManifest(json(text, file))
  if (file.endsWith('/tauri.conf.json')) {
    const config = json(text, file)
    delete config.version
    return config
  }
  if (file.endsWith('/build.gradle.kts'))
    return text.replace(/^[ \t]*version(?:Name|Code)\s*=.*$/gm, '')
  if (file.endsWith('/Cargo.toml') && /^\[package\]/m.test(text))
    return rustVersion(text, file, '0.0.0')
  if (file.endsWith('/Cargo.lock')) {
    return text.replace(/^\[\[package\]\][\s\S]*?(?=^\[\[package\]\]|$(?![\s\S]))/gm, (section) =>
      /^name\s*=\s*"pi-desk-(?:desktop|tunnel-server)"/m.test(section)
        ? section.replace(/^version\s*=.*$/m, 'version = "0.0.0"')
        : section
    )
  }
  return text
}

async function nativeChanged(root, baseline, paths) {
  for (const file of baseline.changed) {
    if (
      excluded.test(file) ||
      /(?:^|\/)(?:signing|licenses)\/|(?:^|\/)(?:\.gitignore|rustfmt\.toml)$/.test(file)
    )
      continue
    if (!paths.some((path) => file === path || file.startsWith(`${path}/`))) continue
    const current = await readOptional(root, file)
    if (
      !isDeepStrictEqual(
        productionContent(file, baseline.read(file)),
        productionContent(file, current)
      )
    )
      return true
  }
  return false
}

async function planNative(root, baseline) {
  const changes = []
  const add = (file, original, content) => {
    if (original !== content) changes.push({ file, original, content })
  }
  const desktopFiles = [
    'apps/desktop/package.json',
    'apps/desktop/src-tauri/tauri.conf.json',
    'apps/desktop/src-tauri/Cargo.toml',
    'apps/desktop/src-tauri/Cargo.lock'
  ]
  const desktop = await Promise.all(desktopFiles.map((file) => readOptional(root, file)))
  if (desktop.every((text) => text !== null)) {
    const manifest = json(desktop[0], desktopFiles[0])
    const config = json(desktop[1], desktopFiles[1])
    assert.ok(
      versionParts(manifest.version)[3] === null && versionParts(config.version)[3] === null,
      '桌面版本必须为正式版本'
    )
    const rust = rustPackage(desktop[2], desktopFiles[2])
    const old = baseline.read(desktopFiles[0])
    const previous = old === null ? null : json(old, desktopFiles[0]).version
    const affected = await nativeChanged(root, baseline, ['apps/desktop', 'apps/tunnel/common'])
    const version = plannedVersion(manifest.version, previous, affected)
    if (manifest.version !== version) {
      manifest.version = version
      add(desktopFiles[0], desktop[0], `${JSON.stringify(manifest, null, 2)}\n`)
    }
    if (config.version !== version) {
      config.version = version
      add(desktopFiles[1], desktop[1], `${JSON.stringify(config, null, 2)}\n`)
    }
    add(desktopFiles[2], desktop[2], rustVersion(desktop[2], desktopFiles[2], version))
    add(desktopFiles[3], desktop[3], lockVersion(desktop[3], rust.name, version))
  }
  const androidFile = 'apps/android/app/build.gradle.kts'
  const android = await readOptional(root, androidFile)
  if (android !== null) {
    const androidVersion = (text) => {
      const version = text.match(/^[ \t]*versionName\s*=\s*"([^"]+)"/m)?.[1]
      const code = Number(text.match(/^[ \t]*versionCode\s*=\s*(\d+)/m)?.[1])
      assert.ok(version && versionParts(version)[3] === null, 'Android 缺少正式 versionName')
      assert.ok(
        Number.isSafeInteger(code) && code > 0 && code <= 2100000000,
        'Android versionCode 无效'
      )
      return { version, code }
    }
    const current = androidVersion(android)
    const old = baseline.read(androidFile)
    const previous = old === null ? null : androidVersion(old)
    const affected = await nativeChanged(root, baseline, ['apps/android'])
    const version = plannedVersion(current.version, previous?.version ?? null, affected)
    const code =
      previous && version !== previous.version
        ? Math.max(current.code, previous.code + 1)
        : Math.max(current.code, previous?.code ?? 0)
    assert.ok(code <= 2100000000, 'Android versionCode 超出平台范围')
    add(
      androidFile,
      android,
      android
        .replace(/^(\s*versionName\s*=\s*")[^"]+(".*)$/m, `$1${version}$2`)
        .replace(/^(\s*versionCode\s*=\s*)\d+/m, `$1${code}`)
    )
  }
  const tunnelFile = 'apps/tunnel/server/Cargo.toml'
  const tunnelLock = 'apps/tunnel/Cargo.lock'
  const tunnel = await readOptional(root, tunnelFile)
  const lock = await readOptional(root, tunnelLock)
  if (tunnel !== null && lock !== null) {
    const current = rustPackage(tunnel, tunnelFile)
    const old = baseline.read(tunnelFile)
    const previous = old === null ? null : rustPackage(old, tunnelFile).version
    const affected = await nativeChanged(root, baseline, [
      'apps/tunnel/server',
      'apps/tunnel/common',
      'apps/tunnel/Cargo.toml',
      tunnelLock,
      'apps/tunnel/Dockerfile',
      'apps/tunnel/.dockerignore'
    ])
    const version = plannedVersion(current.version, previous, affected)
    add(tunnelFile, tunnel, rustVersion(tunnel, tunnelFile, version))
    add(tunnelLock, lock, lockVersion(lock, current.name, version))
  }
  return changes
}

async function applyChanges(root, changes) {
  const attempted = []
  try {
    for (const change of changes) {
      attempted.push(change)
      await writeFile(join(root, change.file), change.content)
    }
  } catch (error) {
    // 失败的写入也可能已截断文件，因此同样恢复其原文。
    const restored = await Promise.allSettled(
      attempted.map((change) => writeFile(join(root, change.file), change.original))
    )
    const failed = attempted.filter((_, index) => restored[index].status === 'rejected')
    if (failed.length)
      throw new Error(`清单写入失败且无法恢复：${failed.map((entry) => entry.file).join('、')}`, {
        cause: error
      })
    throw new Error('清单写入失败，已恢复本次尝试写入的全部清单', { cause: error })
  }
  return changes.map((entry) => entry.file)
}

/** @returns {Promise<{changedFiles: string[], packages: {name: string, version: string}[]}>} */
export async function prepareStableVersions(root, { base = null } = {}) {
  root = resolve(root)
  const baseline = snapshot(root, base)
  const entries = await npmEntries(root, baseline)
  const { changes } = planNpm(entries, { baseline: base })
  changes.push(...(await planNative(root, baseline)))
  // 所有版本、依赖和原生同步均已验证，再统一写入。
  const changedFiles = await applyChanges(root, changes)
  return {
    changedFiles,
    packages: entries.map(({ manifest }) => ({ name: manifest.name, version: manifest.version }))
  }
}

export function nextDevelopmentVersion(planned, publishedVersions) {
  const base = stableVersion(planned)
  assert.ok(Array.isArray(publishedVersions), '已发布版本清单无效')
  let highest = 0
  for (const version of publishedVersions) {
    assert.equal(typeof version, 'string', '已发布版本必须为字符串')
    if (!/^\d+\.\d+\.\d+-dev\.\d+$/.test(version)) continue
    const parts = versionParts(version)
    const comparison = compareVersions(base, version)
    assert.ok(comparison >= 0, `开发基础版本 ${base} 低于已发布版本 ${version}`)
    if (comparison === 0) highest = Math.max(highest, parts[3])
  }
  const next = `${base}-dev.${highest + 1}`
  versionParts(next)
  return next
}

/** @returns {Promise<{changedFiles: string[], packages: {name: string, version: string}[], selected: string[]}>} */
export async function prepareDevelopmentVersions(
  root,
  { before, readVersions, stableBase = null }
) {
  root = resolve(root)
  assert.equal(typeof readVersions, 'function', '缺少已发布开发版本查询')
  assert.ok(
    typeof before === 'string' && /^[a-f0-9]{40}$/i.test(before),
    'before 必须为完整提交 SHA'
  )
  const revision = /^0+$/.test(before) ? null : before
  const baseline = snapshot(root, revision, 'HEAD')
  const entries = await npmEntries(root, baseline)
  // 预规划只确定目标基础版本和消费者，最终编号一次性同步回原始清单。
  const candidates = structuredClone(entries)
  const planned = planNpm(candidates, { baseline: revision ?? 'HEAD', development: true })
  const stable = stableBase ? snapshot(root, stableBase) : null
  const targets = candidates.filter((entry) =>
    planned.selected.includes(entry.manifest.name.slice('@jetcrab/'.length))
  )
  const versions = new Map(
    await Promise.all(
      targets.map(async (entry) => {
        let version = entry.manifest.version
        const published = stable?.read(entry.file)
        if (published) {
          const currentStable = json(published, entry.file).version
          if (compareVersions(version, currentStable) <= 0)
            version = `${patch(stableVersion(currentStable))}-dev.1`
        }
        return [
          entry.manifest.name,
          nextDevelopmentVersion(version, await readVersions(entry.manifest.name))
        ]
      })
    )
  )
  const { changes, selected } = planNpm(entries, {
    baseline: revision ?? 'HEAD',
    development: true,
    versions
  })
  const changedFiles = await applyChanges(root, changes)
  return {
    changedFiles,
    packages: entries.map(({ manifest }) => ({ name: manifest.name, version: manifest.version })),
    selected
  }
}

async function main() {
  assert.ok(process.argv.length <= 3, '用法：node prepare-stable-release.mjs [公开仓库根目录]')
  const root = process.argv[2] ?? resolve(import.meta.dirname, '../..')
  const { changedFiles } = await prepareStableVersions(root)
  for (const file of changedFiles) console.info(file)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}
