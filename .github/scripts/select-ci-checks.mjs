import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { appendFile, readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export function selectPluginChecks(paths, full = false, sdkConsumers = []) {
  if (full) return ['all']
  const changed = paths
    .filter((path) => !path.endsWith('.md'))
    .flatMap((path) => {
      const match = /^plugins\/(pi-desk[^/]+)\//.exec(path)
      return match ? [match[1]] : []
    })
  return [...new Set([...changed, ...(changed.includes('pi-desk-sdk') ? sdkConsumers : [])])]
}

export function selectCiChecks(paths, full) {
  paths = paths.filter((path) => !path.endsWith('.md'))
  return {
    full,
    web:
      full ||
      paths.some((path) =>
        /^(?:src\/|bin\/|plugins\/pi-desk-sdk\/|package\.json$|pnpm-|next\.config|tsconfig|tests\/(?:l4-api-request|l2-(?:chat-state|task-center-state|work-session-update|workbench-layout)|l3-(?:app-runtime-state|project-file-tree))\.test\.)/.test(
          path
        )
      ),
    pidesk:
      full ||
      paths.some((path) =>
        /^(?:src\/|bin\/|plugins\/pi-desk-sdk\/|package\.json$|pnpm-|next\.config|tsconfig|docs\/pi-desk\/examples\/|tests\/(?:l[124]-pidesk(?:-|\.)|l2-plugin-command|l4-(?:e2e-server|browser-cdp)-runtime)|\.github\/(?:scripts\/(?:select-ci-checks|release-npm|verify-npm-install)\.mjs$|workflows\/(?:check|release-npm)\.yml$))/.test(
          path
        )
      ),
    website: full || paths.some((path) => path.startsWith('apps/website/')),
    agent:
      full ||
      paths.some((path) =>
        /^\.github\/release-agent\/|^\.github\/scripts\/release-notes\.mjs$|^tests\/l4-release-agent\.test\.mjs$/.test(
          path
        )
      ),
    automation:
      full ||
      paths.some((path) =>
        /^\.github\/|^\.githooks\/|^apps\/docker\/|^tests\/l4-(?:release|commit-versions|npm-channel|workflow-contracts|restore-sdk|docker|public-boundary)/.test(
          path
        )
      )
  }
}

async function main() {
  const before = process.env.CHECK_BASE
  const full = !before || /^0+$/.test(before)
  const head = process.env.CHECK_HEAD || process.env.GITHUB_SHA
  assert.match(head, /^[a-f0-9]{40}$/)
  const args =
    before && !/^0+$/.test(before)
      ? ['diff', '--name-only', '--no-renames', '-z', before, head]
      : ['ls-tree', '-r', '--name-only', '-z', head]
  if (before) assert.match(before, /^[a-f0-9]{40}$/)
  const paths = execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    .split('\0')
    .filter(Boolean)
  const selected = selectCiChecks(paths, full)
  for (const [key, value] of Object.entries(selected))
    await appendFile(process.env.GITHUB_OUTPUT, `${key}=${value}\n`)
  const sdkConsumers = []
  if (paths.some((path) => path.startsWith('plugins/pi-desk-sdk/') && !path.endsWith('.md'))) {
    for (const entry of await readdir('plugins', { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const manifest = JSON.parse(await readFile(`plugins/${entry.name}/package.json`, 'utf8'))
      if (
        ['dependencies', 'optionalDependencies', 'peerDependencies'].some(
          (group) => manifest[group]?.['@jetcrab/pi-desk-sdk']
        )
      )
        sdkConsumers.push(entry.name)
    }
  }
  const built = new Set(JSON.parse(process.env.CHECK_BUILT_PACKAGES || '[]'))
  const plugins = selectPluginChecks(paths, full, sdkConsumers).filter((name) => !built.has(name))
  await appendFile(
    process.env.GITHUB_OUTPUT,
    `plugins=${JSON.stringify(plugins)}\nfiles=${JSON.stringify(paths)}\n`
  )
  console.log(
    `检查范围：${full ? '无成功基线，完整功能检查' : '按累计差异检查'}；${JSON.stringify(selected)}；插件=${JSON.stringify(plugins)}`
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}
