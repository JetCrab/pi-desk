import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { access, cp, mkdir, readFile, readdir, rename, rm, rmdir, symlink } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { releaseTagPattern } from './release-record.mjs'

export async function normalizeStaticSegments(directory) {
  async function visit(parts) {
    const current = join(directory, ...parts)
    let corrected = 0
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const child = [...parts, entry.name]
      if (entry.isDirectory()) corrected += await visit(child)
      else if (entry.isFile() && entry.name.endsWith('.txt')) {
        const start = child.findIndex((part) => part.startsWith('__next.'))
        if (start >= 0 && start < child.length - 1) {
          await rename(
            join(directory, ...child),
            join(directory, ...child.slice(0, start), child.slice(start).join('.'))
          )
          corrected += 1
        }
      }
    }
    if (
      corrected &&
      parts.some((part) => part.startsWith('__next.')) &&
      !(await readdir(current)).length
    )
      await rmdir(current)
    return corrected
  }
  return visit([])
}

export async function verifyWebsite(directory, tag) {
  assert.match(tag, releaseTagPattern)
  for (const path of ['index.html', 'docs/index.html', 'changelog/index.html', '404.html'])
    await access(join(directory, path))
  const changes = await readFile(join(directory, 'changelog/index.html'), 'utf8')
  assert.match(
    changes,
    new RegExp(`\\b${tag.replaceAll('.', '\\.')}\\b`),
    '官网更新日志缺少本次正式发布'
  )
  const entries = await readdir(directory, { recursive: true })
  assert.ok(
    !entries.some((path) =>
      /(?:^|[\\/])(?:\.env(?:\.|$)|auth\.json|models\.json)|\.(?:pem|p12|pfx|key|keystore)$/iu.test(
        path
      )
    ),
    '官网产物包含私有配置或签名文件'
  )
  assert.ok(
    entries.some((path) => path.endsWith('__PAGE__.txt')),
    '官网静态页面分段缺失'
  )
}

async function main() {
  assert.equal(process.env.GITHUB_ACTIONS, 'true', '正式官网构建只在 GitHub Actions 执行')
  const root = resolve(import.meta.dirname, '../..')
  const website = join(root, 'apps/website')
  const [archive, tag] = process.argv.slice(2)
  assert.ok(archive, '缺少官网归档路径')
  const task = `${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`
  assert.match(task, /^\d+-\d+$/)
  const isolated = join(root, 'temp/build/website', task)
  await mkdir(isolated, { recursive: true })
  try {
    for (const name of [
      'src',
      'public',
      'content',
      'package.json',
      'next.config.ts',
      'tsconfig.json',
      'postcss.config.mjs',
      'site-release.json',
      'scripts'
    ]) {
      await cp(join(website, name), join(isolated, name), { recursive: true })
    }
    await symlink(
      join(website, 'node_modules'),
      join(isolated, 'node_modules'),
      process.platform === 'win32' ? 'junction' : 'dir'
    )
    console.log('开始构建已同步正式发布记录的独立官网。')
    execFileSync(process.execPath, [join(website, 'scripts/check-release.mjs')], {
      cwd: isolated,
      stdio: 'inherit'
    })
    execFileSync(
      process.execPath,
      [join(website, 'node_modules/next/dist/bin/next'), 'build', '--webpack'],
      {
        cwd: isolated,
        env: { ...process.env, PI_WEBSITE_DIST_DIR: '.next', NEXT_TELEMETRY_DISABLED: '1' },
        stdio: 'inherit',
        timeout: 900_000
      }
    )
    const output = join(isolated, 'out')
    await normalizeStaticSegments(output)
    await verifyWebsite(output, tag)
    await mkdir(dirname(resolve(archive)), { recursive: true })
    execFileSync('tar', ['-czf', resolve(archive), '-C', output, '.'], {
      stdio: 'inherit',
      timeout: 120_000
    })
    console.log('官网静态产物已包含当前批次，归档完成。')
  } finally {
    await rm(isolated, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}
