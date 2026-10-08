import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { isDeepStrictEqual } from 'node:util'
import { productionContent } from './prepare-stable-release.mjs'
import { changeSections, clientPlatforms, validateRecord } from './release-record.mjs'
import { versionIncreased } from './npm-channel.mjs'

export function git(root, ...args) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim()
}

function fileAt(root, sha, path) {
  return git(root, 'show', `${sha}:${path}`)
}

export function npmVersionsAt(root, sha) {
  return git(root, 'ls-tree', '-r', '--name-only', sha, '--', 'package.json', 'plugins')
    .split('\n')
    .filter((path) => path === 'package.json' || /^plugins\/[^/]+\/package\.json$/.test(path))
    .map((path) => {
      const manifest = JSON.parse(fileAt(root, sha, path))
      assert.match(manifest.name, /^@jetcrab\/pi-desk(?:-[a-z0-9-]+)?$/)
      assert.match(manifest.version, /^\d+\.\d+\.\d+$/, '正式发布不能含开发版本')
      assert.notEqual(manifest.private, true)
      return { name: manifest.name, version: manifest.version }
    })
    .sort((a, b) =>
      a.name === '@jetcrab/pi-desk-sdk'
        ? -1
        : b.name === '@jetcrab/pi-desk-sdk'
          ? 1
          : a.name.localeCompare(b.name)
    )
}

function clientVersion(root, head, platform) {
  if (platform !== 'android')
    return JSON.parse(fileAt(root, head, 'apps/desktop/package.json')).version
  const content = fileAt(root, head, 'apps/android/app/build.gradle.kts')
  const version = content.match(/^\s*versionName\s*=\s*"([^"]+)"/m)?.[1]
  assert.ok(version, 'Android 缺少 versionName')
  return version
}

function runtimeChanged(root, base, head, paths) {
  return git(root, 'diff', '--name-only', base, head, '--', ...paths)
    .split('\n')
    .filter(Boolean)
    .some((path) => {
      if (
        /(?:^|\/)(?:tests|__tests__)\/|(?:\.test|\.spec)\.|(?:^|\/)test-[^/]+|(?:_tests|tests)\.rs$|\.md$/u.test(
          path
        )
      )
        return false
      const content = (sha) =>
        git(root, 'ls-tree', '--name-only', sha, '--', path)
          ? productionContent(path, fileAt(root, sha, path))
          : null
      return !isDeepStrictEqual(content(base), content(head))
    })
}

export function createReleasePlan(root, { head, previous = null, date = Date.now() }) {
  assert.match(head, /^[a-f0-9]{40}$/)
  if (previous) {
    validateRecord(previous)
    git(root, 'merge-base', '--is-ancestor', previous.source.head, head)
  }
  const base = previous?.source.head ?? null
  const packages = npmVersionsAt(root, head)
  const npm = packages
    .filter((item) => {
      const old = previous?.packages.find((value) => value.name === item.name)
      if (!old) return true
      const increased = versionIncreased(old.version, item.version, item.name)
      if (!increased && base) {
        const paths =
          item.name === '@jetcrab/pi-desk'
            ? ['src', 'bin', 'package.json', 'next.config.ts', 'tsconfig.json']
            : [`plugins/${item.name.slice('@jetcrab/'.length)}`]
        assert.ok(
          !runtimeChanged(root, base, head, paths),
          `${item.name} 运行内容变化但正式版本未递增`
        )
      }
      return increased
    })
    .map((item) => item.name.slice('@jetcrab/'.length))
  const clients = clientPlatforms.map((platform) => {
    const version = clientVersion(root, head, platform)
    assert.match(version, /^\d+\.\d+\.\d+$/)
    const old = previous?.clients.find((item) => item.platform === platform)
    if (!old || versionIncreased(old.version, version, platform))
      return { platform, version, build: true }
    const paths = platform === 'android' ? ['apps/android'] : ['apps/desktop', 'apps/tunnel/common']
    assert.ok(!runtimeChanged(root, base, head, paths), `${platform} 运行内容变化但版本未递增`)
    return { platform, version, build: false, reuse: { tag: previous.tag, ...old } }
  })
  const tunnelVersion = (sha) =>
    fileAt(root, sha, 'apps/tunnel/server/Cargo.toml')
      .split(/^\[package\]\s*$/m)[1]
      ?.split(/^\[/m)[0]
      ?.match(/^version\s*=\s*"([^"]+)"/m)?.[1]
  const nextTunnel = tunnelVersion(head)
  assert.match(nextTunnel, /^\d+\.\d+\.\d+$/)
  const tunnel = !base || versionIncreased(tunnelVersion(base), nextTunnel, 'tunnel')
  const record = {
    tag: `release-${head.slice(0, 12)}`,
    date,
    source: { base, head },
    packages,
    clients: [],
    changes: Object.fromEntries(changeSections.map((key) => [key, []]))
  }
  validateRecord(record)
  return { record, npm, clients, tunnel }
}

export function latestSuccessfulRelease(releases) {
  return (
    releases
      .filter(
        (release) =>
          !release.draft && !release.prerelease && /^release-[a-f0-9]{12}$/.test(release.tag_name)
      )
      .sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at))[0] ?? null
  )
}
