import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { appendFile, copyFile, mkdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { prepareDevelopmentVersions } from './prepare-stable-release.mjs'
import { selectPackages } from './release-npm.mjs'

export function developmentBaseline(root, before) {
  assert.match(before, /^[a-f0-9]{40}$/)
  if (/^0+$/.test(before)) return before
  const entry = execFileSync(
    'git',
    ['ls-tree', '--name-only', before, '--', '.github/scripts/prepare-dev-release.mjs'],
    {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    }
  ).trim()
  // 新发布入口首次启用时，先准备一批开发包；后续仍只发布生产内容变化的包。
  return entry ? before : '0'.repeat(40)
}

export async function manualDevelopmentTargets(root, target) {
  const entries = await selectPackages(root, 'all')
  const selected = new Set(
    (await selectPackages(root, target || 'all')).map((entry) => entry.manifest.name)
  )
  let added
  do {
    added = false
    for (const entry of entries.filter((entry) => selected.has(entry.manifest.name))) {
      for (const group of [
        'dependencies',
        'optionalDependencies',
        'peerDependencies',
        'devDependencies'
      ]) {
        for (const name of Object.keys(entry.manifest[group] ?? {})) {
          if (!selected.has(name) && entries.some((entry) => entry.manifest.name === name)) {
            selected.add(name)
            added = true
          }
        }
      }
    }
  } while (added)
  return entries
    .filter((entry) => selected.has(entry.manifest.name))
    .map((entry) => entry.manifest.name.slice('@jetcrab/'.length))
}

async function main() {
  assert.equal(process.env.GITHUB_ACTIONS, 'true')
  assert.equal(process.env.GITHUB_REF, 'refs/heads/dev')
  const root = resolve(import.meta.dirname, '../..')
  const output = resolve(process.env.DEV_MANIFEST_DIR)
  const number =
    Number(process.env.GITHUB_RUN_NUMBER) * 1000 + Number(process.env.GITHUB_RUN_ATTEMPT)
  const stableBase = execFileSync('git', ['rev-parse', 'origin/main'], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim()
  const result = await prepareDevelopmentVersions(root, {
    before:
      process.env.GITHUB_EVENT_NAME === 'workflow_dispatch'
        ? '0'.repeat(40)
        : developmentBaseline(root, process.env.RELEASE_BEFORE),
    number,
    stableBase
  })
  if (process.env.GITHUB_EVENT_NAME === 'workflow_dispatch') {
    result.selected = await manualDevelopmentTargets(root, process.env.RELEASE_PACKAGE)
  }
  if (result.selected.length) {
    execFileSync(
      'pnpm',
      ['install', '--lockfile-only', '--ignore-scripts', '--registry=https://registry.npmjs.org'],
      { cwd: root, stdio: 'inherit' }
    )
    for (const file of [...result.changedFiles, 'pnpm-lock.yaml']) {
      const destination = join(output, file)
      await mkdir(dirname(destination), { recursive: true })
      await copyFile(join(root, file), destination)
    }
  }
  await appendFile(process.env.GITHUB_OUTPUT, `packages=${JSON.stringify(result.selected)}\n`)
  console.log(
    result.selected.length
      ? `开发测试包：${result.selected.join('、')}`
      : '本次没有 npm 运行内容变化。'
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}
