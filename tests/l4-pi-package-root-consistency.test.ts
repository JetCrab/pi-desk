import assert from 'node:assert/strict'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import test from 'node:test'
import { readL4PiPackageRootConsistencyError } from '../src/server/l4_foundation/pi/l4-pi-package-root-consistency'

const root = resolve('temp', 'pi', 'package-root-consistency-test', String(process.pid))

test.after(async () => {
  await rm(root, { recursive: true, force: true })
})

test('Pi Settings、npm dependencies 和安装目录一致时通过', async () => {
  const agentDir = resolve(root, 'consistent')
  const first = resolve(agentDir, 'npm', 'node_modules', '@scope', 'first')
  const second = resolve(agentDir, 'npm', 'node_modules', 'second')
  await mkdir(first, { recursive: true })
  await mkdir(second, { recursive: true })
  await writeFile(
    resolve(agentDir, 'npm', 'package.json'),
    JSON.stringify({ dependencies: { '@scope/first': '^1.0.0', second: '^2.0.0' } }),
    'utf8'
  )

  assert.equal(
    await readL4PiPackageRootConsistencyError({
      agentDir,
      configured: [
        { source: 'npm:@scope/first@^1.0.0', installedPath: first },
        { source: 'npm:second', installedPath: second }
      ]
    }),
    null
  )
})

test('Settings 已配置的 Package 缺少声明或目录时阻止继续 reify', async () => {
  const agentDir = resolve(root, 'inconsistent')
  const missingDirectory = resolve(agentDir, 'npm', 'node_modules', 'missing')
  await mkdir(resolve(agentDir, 'npm'), { recursive: true })
  await writeFile(
    resolve(agentDir, 'npm', 'package.json'),
    JSON.stringify({ dependencies: { extra: '^1.0.0' } }),
    'utf8'
  )

  const error = await readL4PiPackageRootConsistencyError({
    agentDir,
    configured: [{ source: 'npm:missing', installedPath: missingDirectory }]
  })
  assert.ok(error)
  assert.equal(
    error.message,
    'Pi Package 配置与 npm 根不一致（缺少声明：missing；缺少目录：missing）'
  )
  assert.equal(
    error.englishMessage,
    'Pi Package configuration does not match the npm root (missing declarations: missing; missing folders: missing)'
  )
  assert.deepEqual(error.i18n, {
    key: 'errors:pluginNpmRootMissingBoth',
    params: { declarations: 'missing', folders: 'missing' }
  })
})

test('npm 根读取失败保留原始 ENOENT 及双语错误键参数', async () => {
  const agentDir = resolve(root, 'missing-npm-root')
  const packageJsonPath = resolve(agentDir, 'npm', 'package.json')
  const error = await readL4PiPackageRootConsistencyError({
    agentDir,
    configured: [
      {
        source: 'npm:@scope/missing',
        installedPath: resolve(agentDir, 'npm', 'node_modules', '@scope', 'missing')
      }
    ]
  })

  assert.ok(error)
  const rawError = error.message.replace('Pi Package npm 根不可用：', '')
  assert.match(rawError, /ENOENT/)
  assert.ok(rawError.includes(packageJsonPath))
  assert.equal(error.englishMessage, `Pi Package npm root is unavailable: ${rawError}`)
  assert.deepEqual(error.i18n, {
    key: 'errors:pluginNpmRootUnavailable',
    params: { detail: rawError.slice(0, 1000) }
  })
})

test('npm 根中未被 Settings 配置的 Package 不阻止操作', async () => {
  const agentDir = resolve(root, 'unconfigured-extra')
  const configuredPath = resolve(agentDir, 'npm', 'node_modules', 'configured')
  await mkdir(configuredPath, { recursive: true })
  await writeFile(
    resolve(agentDir, 'npm', 'package.json'),
    JSON.stringify({ dependencies: { configured: '^1.0.0', leftover: '^2.0.0' } }),
    'utf8'
  )

  assert.equal(
    await readL4PiPackageRootConsistencyError({
      agentDir,
      configured: [{ source: 'npm:configured', installedPath: configuredPath }]
    }),
    null
  )
})

test('没有 npm Package 时不要求 npm 根存在', async () => {
  assert.equal(
    await readL4PiPackageRootConsistencyError({
      agentDir: resolve(root, 'local-only'),
      configured: [{ source: 'C:/plugins/local', installedPath: 'C:/plugins/local' }]
    }),
    null
  )
})
