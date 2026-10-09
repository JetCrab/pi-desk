import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmod, readFile, readdir } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

function git(root, ...args) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim()
}

export async function installGitHooks(
  root,
  { ci = process.env.CI || process.env.GITHUB_ACTIONS } = {}
) {
  if (ci && ci !== 'false' && ci !== '0') return { skipped: true }
  root = resolve(root)
  let configured = ''
  try {
    configured = git(root, 'config', '--get', 'core.hooksPath')
  } catch (error) {
    if (error.status !== 1) throw error
  }
  return install(root, configured)
}

async function install(root, configured) {
  const projectHooks = join(root, '.githooks')
  if (configured) {
    const existing = resolve(root, configured)
    assert.equal(
      existing,
      projectHooks,
      `已有非本项目 Hook 路径：${configured}；未覆盖，请手动确认后处理`
    )
  } else {
    const hooksPath = git(root, 'rev-parse', '--git-path', 'hooks')
    const hooks = await readdir(isAbsolute(hooksPath) ? hooksPath : join(root, hooksPath)).catch(
      (error) => {
        if (error.code === 'ENOENT') return []
        throw error
      }
    )
    const active = hooks.filter((name) => !name.endsWith('.sample'))
    assert.equal(
      active.length,
      0,
      `已有非本项目 Hook：${active.join('、')}；未覆盖，请手动确认后处理`
    )
  }
  const hook = join(projectHooks, 'pre-commit')
  const content = await readFile(hook, 'utf8')
  assert.ok(content.includes('/.github/scripts/commit-versions.mjs'), '缺少本项目 pre-commit Hook')
  await chmod(hook, 0o755)
  git(root, 'config', '--local', 'core.hooksPath', '.githooks')
  return { skipped: false, hooksPath: '.githooks' }
}

async function main() {
  const result = await installGitHooks(resolve(import.meta.dirname, '../..'))
  console.info(result.skipped ? 'CI 环境跳过本地 Hook 安装' : '已安装本仓库提交 Hook：.githooks')
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`Hook 安装失败：${error.message}`)
    process.exitCode = 1
  })
}
