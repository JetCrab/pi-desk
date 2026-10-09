import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { appendFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { pathToFileURL } from 'node:url'
import { productionContent } from './prepare-stable-release.mjs'

const excluded =
  /(?:^|\/)(?:docs|tests?|__tests__|androidTest|testFixtures)(?:\/|$)|(?:\.test|\.spec)\.|(?:^|\/)test-[^/]+|(?:_tests|tests)\.rs$|\.(?:md|snap)$/i

export async function selectDevTargets(root, { before, head }) {
  assert.match(before, /^[a-f0-9]{40}$/)
  assert.match(head, /^[a-f0-9]{40}$/)
  const git = (...args) =>
    execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe']
    })
  const first = /^0+$/.test(before)
  const paths = git(
    ...(first
      ? ['ls-tree', '-r', '--name-only', '-z', head]
      : ['diff', '--name-only', '--no-renames', '-z', before, head])
  )
    .split('\0')
    .filter(Boolean)
  const read = (sha, path) => {
    if (!git('ls-tree', '--name-only', sha, '--', path).trim()) return null
    return git('show', `${sha}:${path}`)
  }
  const production = paths.filter((path) => {
    if (excluded.test(path)) return false
    if (first) return true
    const content = (sha) => {
      const text = read(sha, path)
      const value = productionContent(path, text)
      // 安装包的产品版本本身也是构建输入，不能忽略显式升版。
      if (path === 'apps/desktop/package.json' && text !== null)
        return { ...value, version: JSON.parse(text).version }
      if (path === 'apps/android/app/build.gradle.kts') return text
      return value
    }
    return !isDeepStrictEqual(content(before), content(head))
  })
  const affects = (list, prefix) =>
    list.some((path) => path === prefix || path.startsWith(`${prefix}/`))
  const desktop =
    affects(production, 'apps/desktop') ||
    affects(production, 'apps/tunnel/common') ||
    production.includes('apps/tunnel/Cargo.toml') ||
    production.includes('apps/tunnel/Cargo.lock')
  const android = affects(production, 'apps/android')
  const ios =
    affects(production, 'apps/ios') ||
    production.includes('.github/scripts/build-ios.sh') ||
    production.includes('.github/scripts/apple-signing.sh')
  const tunnel =
    affects(production, 'apps/tunnel/server') ||
    affects(production, 'apps/tunnel/common') ||
    production.some((path) =>
      [
        'apps/tunnel/Cargo.toml',
        'apps/tunnel/Cargo.lock',
        'apps/tunnel/Dockerfile',
        'apps/tunnel/.dockerignore'
      ].includes(path)
    )
  return {
    windows: desktop,
    macos: desktop || production.includes('.github/scripts/apple-signing.sh'),
    android,
    ios,
    tunnel,
    desktop_checks: paths.some(
      (path) =>
        (path.startsWith('apps/desktop/') && !path.endsWith('.md')) ||
        path === '.github/scripts/check-desktop-tunnel.mjs'
    ),
    android_checks: paths.some((path) => path.startsWith('apps/android/') && !path.endsWith('.md')),
    tunnel_checks: paths.some((path) => path.startsWith('apps/tunnel/') && !path.endsWith('.md'))
  }
}

async function main() {
  assert.equal(process.env.GITHUB_REF, 'refs/heads/dev')
  const root = resolve(import.meta.dirname, '../..')
  const selected = await selectDevTargets(root, {
    before: process.env.RELEASE_BEFORE,
    head: process.env.GITHUB_SHA
  })
  if (
    process.env.GITHUB_EVENT_NAME === 'workflow_dispatch' &&
    process.env.REQUESTED_TARGET !== 'all'
  ) {
    const target = process.env.REQUESTED_TARGET
    assert.ok(['npm', 'windows', 'macos', 'android', 'ios', 'tunnel'].includes(target))
    for (const name of Object.keys(selected)) {
      selected[name] =
        name === target ||
        (name === 'desktop_checks' && target === 'windows') ||
        name === `${target}_checks`
    }
  }
  for (const [name, value] of Object.entries(selected))
    await appendFile(process.env.GITHUB_OUTPUT, `${name}=${value}\n`)
  console.info(`开发客户端选择：${JSON.stringify(selected)}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}
