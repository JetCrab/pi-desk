import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { appendFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export function selectCiChecks(paths, full) {
  return {
    full,
    web:
      full ||
      paths.some((path) =>
        /^(?:src\/|bin\/|plugins\/|package\.json$|pnpm-|next\.config|tsconfig)/.test(path)
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
      full || paths.some((path) => /^\.github\/|^tests\/l4-(?:release|public-boundary)/.test(path))
  }
}

async function main() {
  const full =
    process.env.GITHUB_REF === 'refs/heads/main' || process.env.GITHUB_BASE_REF === 'main'
  const before = process.env.CHECK_BASE
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
  console.log(`检查模式：${full ? '正式完整检查' : '开发核心检查'}；${JSON.stringify(selected)}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}
