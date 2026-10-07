import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { ESLint } from 'eslint'
import ts from 'typescript'

import piDeskLog from '../src/server/l4_foundation/process/l4-pi-desk-log.js'
import piDeskOptions from '../src/server/l1_entry/node/l1-launch-options.js'

const { createRollingLogWriter } = piDeskLog
const { parseLaunchOptions } = piDeskOptions
const projectRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

test('Pi Desk 命令默认使用本地开发端口', () => {
  assert.deepEqual(parseLaunchOptions([], {}), {
    port: '6233',
    hostname: '127.0.0.1',
    openBrowser: true,
    safeMode: false
  })
})

test('SuperTool 托管启动可使用独立端口且不打开浏览器', () => {
  assert.deepEqual(
    parseLaunchOptions(['start', '-p', '30140', '-H', '127.0.0.1', '--no-open'], {}),
    {
      port: '30140',
      hostname: '127.0.0.1',
      openBrowser: false,
      safeMode: false
    }
  )
})

test('安全模式由CLI选项或环境变量启用', () => {
  assert.equal(parseLaunchOptions(['--safe-mode'], {}).safeMode, true)
  assert.equal(parseLaunchOptions([], { PI_DESK_SAFE_MODE: '1' }).safeMode, true)
})

test('候选预热要求成对提供就绪和激活文件', () => {
  assert.deepEqual(
    parseLaunchOptions(
      [
        'start',
        '--standby-ready-file',
        'C:/temp/ready',
        '--standby-activate-file',
        'C:/temp/activate'
      ],
      {}
    ),
    {
      port: '6233',
      hostname: '127.0.0.1',
      openBrowser: true,
      safeMode: false,
      standbyReadyFile: 'C:/temp/ready',
      standbyActivateFile: 'C:/temp/activate'
    }
  )
  assert.throws(
    () => parseLaunchOptions(['--standby-ready-file', 'C:/temp/ready'], {}),
    /--standby-ready-file.*--standby-activate-file/
  )
})

test('SuperTool 托管日志达到上限后只保留固定备份', (context) => {
  const root = mkdtempSync(path.join(tmpdir(), 'pi-desk-log-'))
  context.after(() => rmSync(root, { recursive: true, force: true }))
  const logPath = path.join(root, 'Pi Desk.log')
  const writer = createRollingLogWriter(logPath, {
    maxBytes: 8,
    backupCount: 2
  })

  writer.write('12345678')
  writer.write('abcdefgh')
  writer.write('ABCDEFGH')
  writer.write('ijklmnop')

  assert.equal(readFileSync(logPath, 'utf8'), 'ijklmnop')
  assert.equal(readFileSync(`${logPath}.1`, 'utf8'), 'ABCDEFGH')
  assert.equal(readFileSync(`${logPath}.2`, 'utf8'), 'abcdefgh')
  assert.equal(existsSync(`${logPath}.3`), false)
})

test('Pi Desk npm 包声明正式入口和构建产物', () => {
  const packageJson = JSON.parse(readFileSync(path.join(projectRoot, 'package.json'), 'utf8'))
  assert.equal(packageJson.name, '@jetcrab/pi-desk')
  assert.deepEqual(packageJson.publishConfig, {
    registry: 'https://registry.npmjs.org',
    access: 'public'
  })
  assert.equal(packageJson.bin['pi-desk'], 'bin/pi-desk.js')
  for (const name of readdirSync(path.join(projectRoot, 'bin'))) {
    assert.doesNotMatch(name, /^l[1-4]-/u)
  }
  assert.equal(
    packageJson.scripts.dev,
    'pnpm run build:plugin-host-runtime && tsx watch --tsconfig tsconfig.json --exclude "temp/**" --exclude "**/node_modules/**" src/server/l1_entry/node/l1-server.ts --dev'
  )
  assert.equal(
    packageJson.scripts.build,
    'pnpm run build:plugin-host-runtime && next build --webpack'
  )
  assert.equal(
    packageJson.scripts['build:plugin-host-runtime'],
    'pnpm --filter @jetcrab/pi-desk-sdk build'
  )
  assert.equal(packageJson.scripts['publish:private'], undefined)
  assert.equal(packageJson.scripts.start, 'node bin/pi-desk.js --no-open')
  assert.ok(packageJson.files.includes('temp/build/pi-desk/release/.next'))
  assert.equal(
    packageJson.files.some((entry) => entry.startsWith('!')),
    false
  )
  assert.ok(packageJson.files.includes('src'))
  for (const file of ['l1-server.ts', 'l1-app-socket-bridge.ts', 'l1-web-auth-bridge.ts']) {
    assert.equal(existsSync(path.join(projectRoot, file)), false)
    assert.ok(existsSync(path.join(projectRoot, 'src/server/l1_entry/node', file)))
  }
  assert.equal(packageJson.dependencies['tsconfig-paths'], '^4.2.0')
  assert.equal(packageJson.engines.node, '>=22.19.0')
  const config = readFileSync(path.join(projectRoot, 'next.config.ts'), 'utf8')
  assert.match(config, /'temp\/build\/pi-desk\/release\/\.next'/u)
  assert.ok(
    path
      .join('temp', 'build', 'pi-desk', 'release', '.next', 'server', 'chunks')
      .replaceAll('\\', '/')
      .includes('.next/server/chunks')
  )
})

test('生产检查排除测试文件，开发检查仍覆盖根目录和插件测试', async () => {
  function configFiles(name) {
    const config = ts.readConfigFile(path.join(projectRoot, name), ts.sys.readFile)
    assert.equal(config.error, undefined)
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, projectRoot)
    assert.deepEqual(parsed.errors, [])
    return parsed.fileNames.map((file) => path.relative(projectRoot, file).replaceAll('\\', '/'))
  }

  const productionFiles = configFiles('tsconfig.json')
  assert.ok(productionFiles.includes('src/server/l1_entry/node/l1-server.ts'))
  assert.ok(productionFiles.includes('src/server/l4_foundation/pi/l4-pi-runtime-register.mjs'))
  assert.ok(productionFiles.includes('src/server/l2_biz/service-process/l2-service-process.js'))
  assert.ok(productionFiles.includes('plugins/pi-desk-subagent/src/pi-desk.ts'))
  assert.equal(
    productionFiles.some((file) => /(?:^|\/)(?:tests|__tests__)\/|\.(?:test|spec)\./u.test(file)),
    false
  )

  const testFiles = configFiles('tsconfig.tests.json')
  assert.ok(testFiles.includes('tests/l4-pidesk-command.test.ts'))
  assert.ok(testFiles.includes('plugins/pi-desk-subagent/tests/package.test.ts'))

  const packageJson = JSON.parse(readFileSync(path.join(projectRoot, 'package.json'), 'utf8'))
  const ignorePatterns = Array.from(
    packageJson.scripts['lint:production'].matchAll(/--ignore-pattern "([^"]+)"/gu),
    (match) => match[1]
  )
  const productionLint = new ESLint({ cwd: projectRoot, ignorePatterns })
  const developmentLint = new ESLint({ cwd: projectRoot })
  for (const file of [
    'tests/l4-pidesk-command.test.ts',
    'plugins/pi-desk-subagent/tests/package.test.ts'
  ]) {
    assert.equal(await productionLint.isPathIgnored(file), true)
    assert.equal(await developmentLint.isPathIgnored(file), false)
  }
  assert.equal(await productionLint.isPathIgnored('src/server/l1_entry/node/l1-server.ts'), false)
  assert.equal(await productionLint.isPathIgnored('plugins/pi-desk-subagent/src/pi-desk.ts'), false)
})
