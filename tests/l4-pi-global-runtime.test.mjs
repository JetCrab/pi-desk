import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import { fileURLToPath, pathToFileURL } from 'node:url'

const exec = promisify(execFile)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const checker = join(root, 'bin/pi-global-runtime.js')
const register = pathToFileURL(
  join(root, 'src/server/l4_foundation/pi/l4-pi-runtime-register.mjs')
).href
const codingAgent = '@earendil-works/pi-coding-agent'
const requirePi = createRequire(
  realpathSync(join(root, 'node_modules', codingAgent, 'package.json'))
)
const semverRoot = dirname(requirePi.resolve('semver/package.json'))
const sdkFunctions = [
  'DefaultPackageManager',
  'DefaultResourceLoader',
  'ModelRuntime',
  'SessionManager',
  'SettingsManager',
  'createAgentSession',
  'createAgentSessionFromServices',
  'createCodingTools',
  'createEventBus',
  'createExtensionRuntime',
  'createReadOnlyTools',
  'defineTool',
  'getAgentDir',
  'getDocsPath',
  'loadProjectContextFiles',
  'loadSkillsFromDir',
  'migrateSessionEntries',
  'parseSessionEntries',
  'resolveModelScopeWithDiagnostics',
  'stripFrontmatter',
  'truncateHead'
]

async function fixture(context) {
  const parent = join(root, 'temp', 'tests', 'pi-global-runtime')
  await mkdir(parent, { recursive: true })
  const directory = await mkdtemp(join(parent, 'global-core-'))
  context.after(() => rm(directory, { recursive: true, force: true }))
  return directory
}

async function writePi(directory, version, missingFunction) {
  const piRoot = join(directory, 'global npm', 'node_modules', codingAgent)
  const dependencies = {}
  for (const name of [
    '@earendil-works/pi-agent-core',
    '@earendil-works/pi-ai',
    '@earendil-works/pi-tui',
    'typebox'
  ]) {
    const dependencyRoot = join(piRoot, 'node_modules', name)
    await mkdir(dependencyRoot, { recursive: true })
    dependencies[name] = name === 'typebox' ? '1.3.7' : `^${version}`
    await writeFile(
      join(dependencyRoot, 'package.json'),
      JSON.stringify({
        name,
        version: name === 'typebox' ? '1.3.7' : version,
        type: 'module',
        main: './index.js',
        ...(name === '@earendil-works/pi-ai' || name === 'typebox'
          ? {
              exports: Object.fromEntries(
                (name === 'typebox'
                  ? ['.', './compile', './value']
                  : ['.', './compat', './oauth', './providers/all']
                ).map((key) => [key, { import: './index.js' }])
              )
            }
          : {})
      })
    )
    await writeFile(join(dependencyRoot, 'index.js'), `export const marker = '${name}:${version}';`)
  }
  await cp(semverRoot, join(piRoot, 'node_modules', 'semver'), { recursive: true })
  await mkdir(join(piRoot, 'dist'), { recursive: true })
  await writeFile(
    join(piRoot, 'package.json'),
    JSON.stringify({
      name: codingAgent,
      version,
      type: 'module',
      bin: { pi: 'dist/cli.js' },
      exports: { '.': { import: './dist/index.js' } },
      dependencies
    })
  )
  await writeFile(join(piRoot, 'dist/cli.js'), '')
  await writeFile(
    join(piRoot, 'dist/index.js'),
    [
      `export const VERSION = '${version}';`,
      'export const identity = {};',
      "export {marker} from '@earendil-works/pi-agent-core';",
      ...sdkFunctions
        .filter((name) => name !== missingFunction)
        .map((name) => `export function ${name}() {}`)
    ].join('\n')
  )
  return piRoot
}

function run(args, piRoot) {
  return exec(process.execPath, args, {
    cwd: root,
    timeout: 20_000,
    env: { ...process.env, PI_DESK_PI_PACKAGE_DIR: piRoot }
  })
}

async function loadIdentity(piRoot) {
  const source = `
import * as sdk from '@earendil-works/pi-coding-agent';
import {createRequire} from 'node:module';
import {realpathSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {createJiti} from 'jiti';
const require = createRequire(import.meta.url);
const cjs = require('@earendil-works/pi-coding-agent');
const jiti = createJiti(process.env.PI_DESK_PI_PACKAGE_DIR + '/package.json');
const plugin = await jiti.import('@earendil-works/pi-coding-agent');
const preResolved = await import(pathToFileURL(realpathSync(${JSON.stringify(join(root, 'node_modules', codingAgent, 'dist/index.js'))})).href);
if (preResolved.identity !== sdk.identity) throw new Error('预解析路径混入旧核心');
console.log('RESULT:' + JSON.stringify({version:sdk.VERSION, marker:sdk.marker, sameCjs:sdk.identity===cjs.identity, samePlugin:sdk.identity===plugin.identity}));
`
  const { stdout } = await run(
    ['--import', register, '--import', 'tsx', '--input-type=module', '-e', source],
    piRoot
  )
  return JSON.parse(
    stdout
      .split(/\r?\n/)
      .find((line) => line.startsWith('RESULT:'))
      .slice(7)
  )
}

test('全局 Pi 缺失时检查返回 missing，启动拒绝本地回退', async (context) => {
  const directory = await fixture(context)
  const missing = join(directory, 'not-installed')
  const { stdout } = await run([checker, '--check'], missing)
  assert.deepEqual(JSON.parse(stdout), {
    status: 'missing',
    version: null,
    path: null,
    installVersion: '1.0.1'
  })
  await assert.rejects(
    run(['--import', register, '-e', "console.log('unexpected-start')"], missing),
    (error) => {
      assert.equal(error.code, 78)
      assert.match(error.stderr, /未安装全局 Pi/)
      assert.doesNotMatch(error.stdout, /unexpected-start/)
      return true
    }
  )
  await assert.rejects(run([join(root, 'bin/pi-desk-preflight.js')], missing), (error) => {
    assert.equal(error.code, 78)
    assert.match(error.stderr, /候选服务提前退出：78/)
    return true
  })
})

test('Pi Desk 不变，替换全局 Pi 后新进程使用新版且三种加载共享实例', async (context) => {
  const directory = await fixture(context)
  const piRoot = await writePi(directory, '1.0.1')
  assert.deepEqual(await loadIdentity(piRoot), {
    version: '1.0.1',
    marker: '@earendil-works/pi-agent-core:1.0.1',
    sameCjs: true,
    samePlugin: true
  })
  await writePi(directory, '1.1.0')
  assert.deepEqual(await loadIdentity(piRoot), {
    version: '1.1.0',
    marker: '@earendil-works/pi-agent-core:1.1.0',
    sameCjs: true,
    samePlugin: true
  })
})

test('全局 Pi 版本过旧时拒绝启动并提示当前基线', async (context) => {
  const directory = await fixture(context)
  const piRoot = await writePi(directory, '0.99.1')
  await assert.rejects(run([checker, '--check'], piRoot), (error) => {
    assert.equal(error.code, 78)
    assert.match(error.stderr, /过旧，需要 1\.0\.1/)
    return true
  })
})

test('全局 Pi 核心依赖不一致或 SDK 缺失时返回前置失败', async (context) => {
  const directory = await fixture(context)
  const piRoot = await writePi(directory, '1.0.1')
  const dependencyPath = join(piRoot, 'node_modules', '@earendil-works/pi-ai', 'package.json')
  const dependency = JSON.parse(await readFile(dependencyPath, 'utf8'))
  await writeFile(dependencyPath, JSON.stringify({ ...dependency, version: '0.99.1' }))
  await assert.rejects(run([checker, '--check'], piRoot), (error) => {
    assert.equal(error.code, 78)
    assert.match(error.stderr, /核心依赖不一致/)
    return true
  })
  await writePi(directory, '1.0.1', 'createAgentSessionFromServices')
  await assert.rejects(run([checker, '--check'], piRoot), (error) => {
    assert.equal(error.code, 78)
    assert.match(error.stderr, /不兼容.*createAgentSessionFromServices/)
    return true
  })
})

test('正式包与 SDK 将 Pi 设为 optional peer，保留开发版本基准', async () => {
  const host = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  const sdk = JSON.parse(await readFile(join(root, 'plugins/pi-desk-sdk/package.json'), 'utf8'))
  for (const name of [
    codingAgent,
    '@earendil-works/pi-agent-core',
    '@earendil-works/pi-ai',
    '@earendil-works/pi-tui'
  ]) {
    assert.equal(host.dependencies[name], undefined)
    assert.equal(host.devDependencies[name], '1.0.1')
  }
  assert.equal(host.peerDependenciesMeta[codingAgent].optional, true)
  assert.equal(sdk.peerDependenciesMeta[codingAgent].optional, true)
})
