import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { versionParts } from './npm-channel.mjs'
import { lockDependencyContent } from './release-dependencies.mjs'

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

function plannedVersion(current, previous, affected) {
  const version = stableVersion(current)
  const comparison = previous === null ? 1 : compareVersions(version, previous)
  // 提交准备可使用成功发布基线迁移累计改动，已明确提高的版本保留。
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

async function npmEntries(
  root,
  baseline,
  { docker = false, read = (file) => readOptional(root, file), files = null } = {}
) {
  const lockChanged = baseline.changed.has('pnpm-lock.yaml')
  const currentLock = lockChanged ? await read('pnpm-lock.yaml') : null
  const previousLock = lockChanged ? baseline.read('pnpm-lock.yaml') : null
  if (files === null) {
    const plugins = await readdir(join(root, 'plugins'), { withFileTypes: true }).catch((error) => {
      if (error.code === 'ENOENT') return []
      throw error
    })
    files = [
      'package.json',
      ...plugins
        .filter((entry) => entry.isDirectory())
        .map((entry) => `plugins/${entry.name}/package.json`)
        .sort()
    ]
  }
  files = files.filter(
    (file) => file === 'package.json' || /^plugins\/[^/]+\/package\.json$/.test(file)
  )
  const entries = []
  const names = new Set()
  for (const file of files) {
    const original = await read(file)
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
    const dependencyChanged =
      lockChanged &&
      !isDeepStrictEqual(
        lockDependencyContent(previousLock, directory),
        lockDependencyContent(currentLock, directory)
      )
    const affected =
      dependencyChanged ||
      [...baseline.changed].some((path) => {
        if (excluded.test(path)) return false
        if (path === file)
          return (
            !previous ||
            !isDeepStrictEqual(productionManifest(manifest), productionManifest(previous))
          )
        return directory === '.'
          ? /^(?:src|bin)\//.test(path) ||
              rootConfig.test(path) ||
              (docker &&
                ((/^apps\/docker\//.test(path) && path !== 'apps/docker/compose.yaml') ||
                  path === '.github/scripts/release-docker.mjs'))
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

function chooseVersion(id, current, previous, affected, options) {
  if (!options.targets) return plannedVersion(current, previous, affected)
  if (!options.targets.includes(id)) return current
  if (options.mode === 'current') return stableVersion(current)
  if (options.mode === 'patch') return patch(current)
  const parts = versionParts(current).slice(0, 3)
  parts[1]++
  parts[2] = 0
  const version = parts.join('.')
  versionParts(version)
  return version
}

function planNpm(entries, { baseline, ...options }) {
  const selected = new Set()
  for (const entry of entries) {
    const previous = entry.previous?.version ?? null
    const versionChanged = previous !== null && compareVersions(entry.currentVersion, previous) > 0
    const affected = options.targets
      ? options.targets.includes(entry.manifest.name.slice('@jetcrab/'.length))
      : entry.affected || versionChanged || (baseline !== null && previous === null)
    if (affected) selected.add(entry.manifest.name)
    entry.manifest.version = chooseVersion(
      entry.manifest.name.slice('@jetcrab/'.length),
      entry.currentVersion,
      previous,
      affected,
      options
    )
  }
  // 自有依赖的制品版本变化会影响消费者；workspace 范围不需要改写。
  let added
  do {
    added = false
    for (const entry of entries) {
      if (selected.has(entry.manifest.name)) continue
      const affected = dependencyGroups.some((group) =>
        Object.keys(entry.manifest[group] ?? {}).some(
          (name) =>
            selected.has(name) &&
            (!options.targets ||
              entries.some(
                (target) =>
                  target.manifest.name === name && target.manifest.version !== target.currentVersion
              ))
        )
      )
      if (!affected) continue
      selected.add(entry.manifest.name)
      entry.manifest.version = plannedVersion(
        entry.currentVersion,
        entry.previous?.version ?? null,
        true
      )
      added = true
    }
  } while (added)
  const byName = new Map(entries.map((entry) => [entry.manifest.name, entry]))
  const changes = []
  for (const entry of entries) {
    for (const group of dependencyGroups) {
      for (const [name, range] of Object.entries(entry.manifest[group] ?? {})) {
        const target = byName.get(name)
        if (target) entry.manifest[group][name] = dependencyRange(range, target, false)
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
  if (file === 'apps/ios/project.yml')
    return text.replace(/^[ \t]*(?:MARKETING_VERSION|CURRENT_PROJECT_VERSION):.*$/gm, '')
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

async function nativeChanged(root, baseline, paths, read = (file) => readOptional(root, file)) {
  for (const file of baseline.changed) {
    if (
      excluded.test(file) ||
      /(?:^|\/)(?:signing|licenses)\/|(?:^|\/)(?:\.gitignore|rustfmt\.toml)$/.test(file)
    )
      continue
    if (!paths.some((path) => file === path || file.startsWith(`${path}/`))) continue
    const current = await read(file)
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

async function planNative(root, baseline, options = {}) {
  const read = options.read ?? ((file) => readOptional(root, file))
  const changed = (paths) => nativeChanged(root, baseline, paths, read)
  const select = (id, current, previous, affected) => {
    if (affected) options.affected?.add(id)
    return chooseVersion(id, current, previous, affected, options)
  }
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
  const desktop = await Promise.all(desktopFiles.map(read))
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
    const affected = await changed(['apps/desktop', 'apps/tunnel/common'])
    const version = select('desktop', manifest.version, previous, affected)
    if (manifest.version !== version) {
      manifest.version = version
      add(desktopFiles[0], desktop[0], `${JSON.stringify(manifest, null, 2)}\n`)
    }
    if (config.version !== version) {
      add(
        desktopFiles[1],
        desktop[1],
        desktop[1].replace(/("version"\s*:\s*")[^"]+("\s*[,}])/, `$1${version}$2`)
      )
    }
    add(desktopFiles[2], desktop[2], rustVersion(desktop[2], desktopFiles[2], version))
    add(desktopFiles[3], desktop[3], lockVersion(desktop[3], rust.name, version))
  }
  const androidFile = 'apps/android/app/build.gradle.kts'
  const android = await read(androidFile)
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
    const affected = await changed(['apps/android'])
    const version = select('android', current.version, previous?.version ?? null, affected)
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
  const tunnel = await read(tunnelFile)
  const lock = await read(tunnelLock)
  if (tunnel !== null && lock !== null) {
    const current = rustPackage(tunnel, tunnelFile)
    const old = baseline.read(tunnelFile)
    const previous = old === null ? null : rustPackage(old, tunnelFile).version
    const affected = await changed([
      'apps/tunnel/server',
      'apps/tunnel/common',
      'apps/tunnel/Cargo.toml',
      tunnelLock,
      'apps/tunnel/Dockerfile',
      'apps/tunnel/.dockerignore'
    ])
    const version = select('tunnel', current.version, previous, affected)
    add(tunnelFile, tunnel, rustVersion(tunnel, tunnelFile, version))
    add(tunnelLock, lock, lockVersion(lock, current.name, version))
  }
  const iosFile = 'apps/ios/project.yml'
  const ios = await read(iosFile)
  if (ios !== null) {
    const parse = (text) => {
      const version = text.match(/^\s*MARKETING_VERSION:\s*['"]?([\d.]+)['"]?\s*$/m)?.[1]
      const build = Number(text.match(/^\s*CURRENT_PROJECT_VERSION:\s*['"]?(\d+)['"]?\s*$/m)?.[1])
      assert.ok(version && versionParts(version)[3] === null, 'iOS 缺少正式 MARKETING_VERSION')
      assert.ok(Number.isSafeInteger(build) && build > 0, 'iOS 构建号无效')
      return { version, build }
    }
    const current = parse(ios)
    const old = baseline.read(iosFile)
    const previous = old === null ? null : parse(old)
    const version = select(
      'ios',
      current.version,
      previous?.version ?? null,
      await changed(['apps/ios'])
    )
    const build = Math.max(
      current.build,
      (previous?.build ?? 0) + (previous && version !== previous.version ? 1 : 0)
    )
    assert.ok(Number.isSafeInteger(build), 'iOS 构建号超出安全整数范围')
    add(
      iosFile,
      ios,
      ios
        .replace(/^(\s*MARKETING_VERSION:\s*)[^\r\n]+/m, `$1${version}`)
        .replace(/^(\s*CURRENT_PROJECT_VERSION:\s*)[^\r\n]+/m, `$1${build}`)
    )
  }
  const websiteFile = 'apps/website/package.json'
  const website = await read(websiteFile)
  if (website !== null) {
    const manifest = json(website, websiteFile)
    const old = baseline.read(websiteFile)
    const version = select(
      'website',
      manifest.version,
      old === null ? null : json(old, websiteFile).version,
      await changed(['apps/website'])
    )
    if (manifest.version !== version) {
      manifest.version = version
      add(websiteFile, website, `${JSON.stringify(manifest, null, 2)}\n`)
    }
  }
  return changes
}

// 提交入口传入 Git index 的只读快照，规划期间不触碰工作树或暂存区。
export async function planVersionChanges(root, baseline, options = {}) {
  const entries = await npmEntries(root, baseline, { docker: true, ...options })
  const plan = planNpm(entries, { baseline: 'HEAD', ...options })
  const affected = new Set(
    entries
      .filter((entry) => entry.affected)
      .map((entry) => entry.manifest.name.slice('@jetcrab/'.length))
  )
  const changedVersions = new Set(
    entries
      .filter((entry) => entry.previous && entry.currentVersion !== entry.previous.version)
      .map((entry) => entry.manifest.name.slice('@jetcrab/'.length))
  )
  let added
  do {
    added = false
    for (const entry of entries) {
      const id = entry.manifest.name.slice('@jetcrab/'.length)
      if (affected.has(id)) continue
      if (
        !dependencyGroups.some((group) =>
          Object.keys(entry.manifest[group] ?? {}).some(
            (name) =>
              name.startsWith('@jetcrab/') &&
              (affected.has(name.slice('@jetcrab/'.length)) ||
                changedVersions.has(name.slice('@jetcrab/'.length)))
          )
        )
      )
        continue
      affected.add(id)
      added = true
    }
  } while (added)
  plan.changes.push(...(await planNative(root, baseline, { ...options, affected })))
  return { ...plan, affected: [...affected], entries }
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

export function nextDevelopmentVersion(planned, publishedVersions) {
  const base = stableVersion(planned)
  assert.ok(Array.isArray(publishedVersions), '已发布版本清单无效')
  let highest = 0
  for (const version of publishedVersions) {
    assert.equal(typeof version, 'string', '已发布版本必须为字符串')
    if (/^\d+\.\d+\.\d+$/.test(version)) {
      assert.ok(
        compareVersions(base, version) > 0,
        `开发基础版本 ${base} 必须高于已成功正式版本 ${version}`
      )
      continue
    }
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
  { before, readVersions, stableBase = null, selected = null, versions = {} }
) {
  root = resolve(root)
  assert.ok(
    typeof before === 'string' && /^[a-f0-9]{40}$/i.test(before),
    'before 必须为完整提交 SHA'
  )
  const revision = /^0+$/.test(before) ? null : before
  const baseline = snapshot(root, revision, 'HEAD')
  const committedFiles = git(root, 'ls-tree', '-r', '--name-only', '-z', 'HEAD')
    .split('\0')
    .filter(Boolean)
  const committed = new Set(committedFiles)
  const entries = await npmEntries(
    root,
    { ...baseline, changed: new Set() },
    {
      files: committedFiles,
      read: (file) => (committed.has(file) ? git(root, 'show', `HEAD:${file}`) : null)
    }
  )
  selected ??= entries
    .filter((entry) => entry.previous === null || entry.currentVersion !== entry.previous.version)
    .map((entry) => entry.manifest.name.slice('@jetcrab/'.length))
  assert.ok(Array.isArray(selected), 'selected 必须为 npm 短名列表')
  for (const id of selected)
    assert.ok(
      entries.some((entry) => entry.manifest.name === `@jetcrab/${id}`),
      `未知开发包：${id}`
    )
  const stable = stableBase ? snapshot(root, stableBase) : null
  const assigned = new Map(
    await Promise.all(
      entries
        .filter((entry) => selected.includes(entry.manifest.name.slice('@jetcrab/'.length)))
        .map(async (entry) => {
          const base = stableVersion(entry.currentVersion)
          const published = stable?.read(entry.file)
          if (published)
            assert.ok(
              compareVersions(base, json(published, entry.file).version) > 0,
              `${entry.manifest.name} 开发基础版本 ${base} 必须高于已成功正式版本`
            )
          const fixed = versions[entry.manifest.name.slice('@jetcrab/'.length)]
          let version
          if (fixed !== undefined) {
            assert.ok(
              versionParts(fixed)[3] !== null && stableVersion(fixed) === base,
              `${entry.manifest.name} 固定开发版本必须使用已提交基础版本 ${base}`
            )
            version = fixed
          } else {
            assert.equal(typeof readVersions, 'function', '缺少已发布开发版本查询')
            version = nextDevelopmentVersion(base, await readVersions(entry.manifest.name))
          }
          return [entry.manifest.name, version]
        })
    )
  )
  // 未重新发布的 workspace 依赖仍须使用成功批次中的真实开发版本。
  for (const [id, version] of Object.entries(versions)) {
    const name = `@jetcrab/${id}`
    if (assigned.has(name)) continue
    const entry = entries.find((item) => item.manifest.name === name)
    assert.ok(
      entry && stableVersion(version) === stableVersion(entry.currentVersion),
      `开发依赖版本与源码不匹配：${id}`
    )
    assert.notEqual(versionParts(version)[3], null, `开发依赖缺少预发布编号：${id}`)
    assigned.set(name, version)
  }
  // 消费者由提交 Hook 升版，CI 不另行扩选或递增基础版本。
  const byName = new Map(entries.map((entry) => [entry.manifest.name, entry]))
  for (const entry of entries)
    if (assigned.has(entry.manifest.name))
      entry.manifest.version = assigned.get(entry.manifest.name)
  const changes = []
  for (const entry of entries) {
    if (!assigned.has(entry.manifest.name)) continue
    for (const group of dependencyGroups) {
      for (const [name, range] of Object.entries(entry.manifest[group] ?? {})) {
        const target = byName.get(name)
        if (target && assigned.has(name))
          entry.manifest[group][name] = dependencyRange(range, target, true)
      }
    }
    const original = await readOptional(root, entry.file)
    assert.ok(original !== null, `缺少开发包清单：${entry.file}`)
    if (!isDeepStrictEqual(json(original, entry.file), entry.manifest))
      changes.push({
        file: entry.file,
        original,
        content: `${JSON.stringify(entry.manifest, null, 2)}\n`
      })
  }
  const changedFiles = await applyChanges(root, changes)
  return {
    changedFiles,
    packages: entries.map(({ manifest }) => ({ name: manifest.name, version: manifest.version })),
    selected: [...new Set(selected)].sort((a, b) =>
      a === 'pi-desk-sdk' ? -1 : b === 'pi-desk-sdk' ? 1 : a.localeCompare(b)
    )
  }
}
