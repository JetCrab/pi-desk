import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { appendFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { selectPackages } from './release-npm.mjs'
import { npmTagFor, versionParts, versionIncreased } from './npm-channel.mjs'

function git(root, ...args) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  })
}

function manifestAt(root, revision, path) {
  return JSON.parse(git(root, 'show', `${revision}:${path}`))
}

export async function selectRelease(root, kind, event) {
  assert.ok(['npm', 'tunnel'].includes(kind), '未知发布类型')
  assert.ok(
    event.ref === 'refs/heads/main' || (kind === 'npm' && event.ref === 'refs/heads/dev'),
    '发布只允许main；npm开发包可使用dev分支'
  )
  assert.ok(['push', 'workflow_dispatch'].includes(event.event), '不支持的发布事件')
  if (event.event === 'workflow_dispatch') {
    return kind === 'tunnel'
      ? ['tunnel']
      : (await selectPackages(root, event.package ?? 'all')).map((entry) => {
          npmTagFor(event.ref, entry.manifest.version)
          return entry.manifest.name.slice('@jetcrab/'.length)
        })
  }
  assert.match(event.before, /^[a-f0-9]{40}$/)
  assert.match(event.after, /^[a-f0-9]{40}$/)
  // 创建分支没有可比较的发布基线，不把整个仓库误当成一次版本升级。
  if (/^0+$/.test(event.before)) return []
  const paths = kind === 'npm' ? ['package.json', 'plugins'] : ['apps/tunnel/server/Cargo.toml']
  const list = (revision) =>
    new Set(
      git(root, 'ls-tree', '-r', '--name-only', '-z', revision, '--', ...paths)
        .split('\0')
        .filter(Boolean)
    )
  const beforeFiles = list(event.before)
  const afterFiles = list(event.after)
  if (kind === 'tunnel') {
    const path = paths[0]
    if (!afterFiles.has(path)) return []
    const readVersion = (revision) => {
      const text = git(root, 'show', `${revision}:${path}`)
      const section = text.split(/^\[package\]\s*$/m)[1]?.split(/^\[/m)[0]
      const version = section?.match(/^version\s*=\s*"([^"]+)"/m)?.[1]
      assert.ok(version, '隧道服务清单缺少显式版本号')
      assert.equal(versionParts(version)[3], null, '隧道服务使用正式版本号')
      return version
    }
    return versionIncreased(
      beforeFiles.has(path) ? readVersion(event.before) : null,
      readVersion(event.after),
      path
    )
      ? ['tunnel']
      : []
  }
  const names = []
  for (const path of afterFiles) {
    if (path !== 'package.json' && !/^plugins\/[^/]+\/package\.json$/.test(path)) continue
    const after = manifestAt(root, event.after, path)
    const before = beforeFiles.has(path) ? manifestAt(root, event.before, path) : null
    assert.match(after.name, /^@jetcrab\/pi-desk(?:-[a-z0-9-]+)?$/)
    if (before) assert.equal(before.name, after.name, '包名变化需单独确认首次发布')
    if (!versionIncreased(before?.version ?? null, after.version, path)) continue
    // main 同步回 dev 的正式版本不重复发布；开发制品必须带预发布后缀。
    if (event.ref === 'refs/heads/dev' && versionParts(after.version)[3] === null) continue
    npmTagFor(event.ref, after.version)
    names.push(after.name.slice('@jetcrab/'.length))
  }
  return names.sort((a, b) =>
    a === 'pi-desk-sdk' ? -1 : b === 'pi-desk-sdk' ? 1 : a.localeCompare(b)
  )
}

async function main() {
  const root = resolve(import.meta.dirname, '../..')
  const targets = await selectRelease(root, process.argv[2], {
    event: process.env.GITHUB_EVENT_NAME,
    ref: process.env.GITHUB_REF,
    before: process.env.RELEASE_BEFORE,
    after: process.env.GITHUB_SHA,
    package: process.env.RELEASE_PACKAGE
  })
  await appendFile(
    process.env.GITHUB_OUTPUT,
    `packages=${JSON.stringify(targets)}\nchanged=${targets.length > 0}\n`
  )
  const summary = targets.length
    ? `本次发布目标：${targets.join('、')}`
    : '没有符合当前通道的版本变化，跳过打包与发布。'
  console.info(summary)
  if (process.env.GITHUB_STEP_SUMMARY)
    await appendFile(process.env.GITHUB_STEP_SUMMARY, summary + '\n')
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}
