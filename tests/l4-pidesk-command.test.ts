import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { createJiti } from 'jiti'

const require = createRequire(import.meta.url)
const jiti = createJiti(import.meta.url, {
  moduleCache: false,
  alias: { 'server-only': join(dirname(require.resolve('server-only')), 'empty.js') }
})
const { parseL4PiDeskCommand: parse } = jiti(
  '../src/server/l4_foundation/pidesk/l4-pidesk-command.ts'
) as typeof import('../src/server/l4_foundation/pidesk/l4-pidesk-command')

test('命令帮助由当前命令定义生成，包含统一安装与卸载语义', () => {
  const root = parse([])
  assert.equal(root.kind, 'help')
  if (root.kind !== 'help') return
  assert.match(root.message, /plugins install <name> --scope global/)
  assert.match(root.message, /plugins remove <name> --scope global/)
  assert.doesNotMatch(root.message, /--scope project/)
  const install = parse(['plugins', 'install', '--help'])
  assert.equal(install.kind, 'help')
  if (install.kind !== 'help') return
  assert.match(install.message, /install \+ update \+ reinstall/)
  assert.match(install.message, /latest/)
  assert.throws(() => parse(['plugins', 'unknown', '--help']), /未知/)
})

test('解析查询、最新安装、指定版本和卸载', () => {
  assert.deepEqual(parse(['--version']), { kind: 'version' })
  assert.deepEqual(parse(['info']), { kind: 'info' })
  assert.deepEqual(parse(['plugins', 'list']), { kind: 'plugins', action: 'list' })
  assert.deepEqual(parse(['plugins', 'show', 'tapd', '--scope', 'global']), {
    kind: 'plugins',
    action: 'show',
    name: 'tapd'
  })
  assert.deepEqual(parse(['plugins', 'install', '@example/plugin', '--scope', 'global']), {
    kind: 'plugins',
    action: 'install',
    name: '@example/plugin'
  })
  assert.deepEqual(
    parse(['plugins', 'install', 'plugin', '--version', '1.2.3-beta.1', '--scope', 'global']),
    {
      kind: 'plugins',
      action: 'install',
      name: 'plugin',
      version: '1.2.3-beta.1'
    }
  )
  assert.deepEqual(parse(['plugins', 'remove', 'plugin', '--scope', 'global']), {
    kind: 'plugins',
    action: 'remove',
    name: 'plugin'
  })
})

test('当前会话重载可发现且不接受目标或额外参数', () => {
  assert.deepEqual(parse(['session', 'reload']), { kind: 'session', action: 'reload' })
  for (const args of [[], ['session'], ['session', '--help'], ['session', 'reload', '--help']]) {
    const result = parse(args)
    assert.equal(result.kind, 'help')
    if (result.kind === 'help') assert.match(result.message, /pidesk session reload/)
  }
  assert.throws(() => parse(['session', 'reset']), /未知/)
  assert.throws(() => parse(['session', 'unknown', '--help']), /未知/)
  assert.throws(() => parse(['session', 'reload', 'another-session']), /不支持的参数/)
  assert.throws(() => parse(['session', 'reload', '--scope', 'global']), /不支持的参数/)
})

test('拒绝错误范围、自定义路径和多余参数，不猜测命令目标', () => {
  const install = ['plugins', 'install', 'plugin']
  assert.throws(() => parse(install), /必须指定/)
  assert.throws(() => parse([...install, '--scope', 'project']), /不支持项目/)
  assert.throws(() => parse([...install, '--scope']), /缺少范围/)
  assert.throws(() => parse([...install, '--scope', 'global', '--scope', 'global']), /重复/)
  for (const name of [
    '../plugin',
    '/tmp/plugin',
    'C:\\plugins\\one',
    'foo/bar',
    'node_modules',
    'plugin@1.0.0'
  ]) {
    assert.throws(() => parse(['plugins', 'install', name, '--scope', 'global']), /名字/)
  }
  for (const version of ['latest', '^1.0.0', '1.0', 'v1.0.0']) {
    assert.throws(
      () => parse([...install, '--scope', 'global', '--version', version]),
      /完整版本号/
    )
  }
  assert.throws(
    () => parse(['plugins', 'remove', 'plugin', '--scope', 'global', '--version', '1.0.0']),
    /不支持的参数/
  )
  assert.throws(() => parse(['info', 'extra']), /不支持的参数/)
  assert.throws(() => parse(['plugins', 'update', 'plugin']), /未知命令/)
})
