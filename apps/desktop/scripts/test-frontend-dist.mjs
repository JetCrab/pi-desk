import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const projectRoot = resolve(desktopRoot, '../..')
const target = resolve(process.argv[2] ?? '')
assert.ok(process.argv[2], '请传入本次隔离的 Cargo 产物目录')
assert.ok(
  target.startsWith(join(projectRoot, 'temp/build/desktop-rust') + sep),
  '检查必须使用项目内隔离构建目录'
)
const root = join(
  projectRoot,
  'temp/run/desktop-frontend-check',
  `reject-invalid-dist-${process.pid}-${Date.now()}`
)
await mkdir(root, { recursive: true })

try {
  for (const [name, frontendDist, expected] of [
    ['windows-path', 'C:/build/desktop-web', '必须是相对资源目录'],
    ['url', 'https://example.invalid/desktop/', '必须是相对资源目录'],
    ['missing-assets', '../../../temp/build/desktop-web/missing-ui-fixture', '桌面页面资源缺失']
  ]) {
    const result = spawnSync(
      'cargo',
      [
        'build',
        '--release',
        '--manifest-path',
        'src-tauri/Cargo.toml',
        '--target',
        'i686-pc-windows-msvc'
      ],
      {
        cwd: desktopRoot,
        env: {
          ...process.env,
          CARGO_TARGET_DIR: target,
          TAURI_CONFIG: JSON.stringify({ build: { frontendDist } })
        },
        encoding: 'utf8',
        windowsHide: true,
        timeout: 300_000,
        maxBuffer: 8 * 1024 * 1024
      }
    )
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
    await writeFile(join(root, `${name}.log`), output)
    if (result.error) throw result.error
    assert.notEqual(result.status, 0, `${name} 未被构建拒绝`)
    assert.ok(output.includes(expected), `${name} 未因预期的资源校验失败：\n${output}`)
    console.info(`通过：${name} 在构建时被拒绝`)
  }
  await rm(root, { recursive: true, force: true })
} catch (error) {
  console.error(`前端资源构建检查失败，现场：${root}`)
  throw error
}
