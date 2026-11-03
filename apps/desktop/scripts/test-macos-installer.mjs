import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { testInstallerPackage } from '../tests/l4-macos-installer-package.mjs'

assert.equal(process.platform, 'darwin', '原生安装器验收需要 macOS')
const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const project = resolve(desktop, '../..')
const output = join(project, 'temp/run/desktop-macos-installer')
await mkdir(output, { recursive: true })
const root = await mkdtemp(join(output, 'run-'))
const binary = join(root, 'installer-tests')
execFileSync(
  '/usr/bin/xcrun',
  [
    'swiftc',
    '-swift-version',
    '5',
    '-warnings-as-errors',
    '-module-cache-path',
    join(root, 'module-cache'),
    join(desktop, 'installer-macos/l4-installer-engine.swift'),
    join(desktop, 'installer-macos/l2-installer-window.swift'),
    join(desktop, 'tests/l4-macos-installer.swift'),
    '-o',
    binary
  ],
  { stdio: 'inherit' }
)
const child = spawn(binary, [root, join(desktop, 'src-tauri/icons/128x128@2x.png')], {
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: true
})
let log = ''
for (const stream of [child.stdout, child.stderr]) {
  stream.on('data', (data) => {
    log += data
    process.stdout.write(data)
  })
}
let timedOut = false
const timer = setTimeout(() => {
  timedOut = true
  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch (error) {
    if (error.code !== 'ESRCH') throw error
  }
}, 120_000)
try {
  const code = await new Promise((resolve, reject) => {
    child.on('error', reject)
    child.on('close', resolve)
  })
  assert.ok(!timedOut, '安装器隔离验收超时，已终止测试进程组')
  assert.equal(code, 0, '安装器隔离验收失败')
  clearTimeout(timer)
  await testInstallerPackage(root, desktop)
  log += '\nPASS 通用离线 DMG 组装、双架构、ad-hoc 签名与内置包校验（隔离 fixture，非真实主应用）\n'
} finally {
  clearTimeout(timer)
  await writeFile(join(root, 'results.log'), log)
  console.log(`验收结果：${root}`)
}
