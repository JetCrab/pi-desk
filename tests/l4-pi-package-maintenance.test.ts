import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { classifyL4PiPackageMaintenanceFailure } from '../src/server/l4_foundation/pi/l4-pi-package-maintenance'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const runnerPath = join(
  projectRoot,
  'src/server/l4_foundation/pi/l4-pi-package-maintenance-runner.mts'
)

type PackageSettings = { packages?: unknown }

function readConfiguredPackages(agentDir: string): string[] {
  const settings = JSON.parse(
    readFileSync(join(agentDir, 'settings.json'), 'utf8')
  ) as PackageSettings
  if (!Array.isArray(settings.packages)) return []
  return settings.packages.flatMap((entry: unknown) => {
    if (typeof entry === 'string') return [entry]
    if (typeof entry !== 'object' || entry === null || !('source' in entry)) return []
    return typeof entry.source === 'string' ? [entry.source] : []
  })
}

function hasConfiguredSource(agentDir: string, source: string): boolean {
  return readConfiguredPackages(agentDir).some(
    (configuredSource) => resolve(agentDir, configuredSource) === resolve(source)
  )
}

function runRunner(
  action: 'install' | 'remove',
  source: string,
  agentDir: string,
  maintenanceCwd?: string
): Promise<string> {
  const env = { ...process.env }
  for (const name of Object.keys(env)) {
    if (/^PI_/i.test(name) || name === 'NODE_OPTIONS' || name === 'TSX_TSCONFIG_PATH') {
      delete env[name]
    }
  }
  env.PI_CODING_AGENT_DIR = agentDir
  env.PI_CODING_AGENT_SESSION_DIR = join(agentDir, 'sessions')
  if (maintenanceCwd) env.PI_DESK_PACKAGE_MAINTENANCE_CWD = maintenanceCwd

  return new Promise((resolveRun, rejectRun) => {
    const startedAt = Date.now()
    process.stdout.write(`$ node ${runnerPath} ${action} ${source}\n`)
    execFile(
      process.execPath,
      [runnerPath, action, source],
      {
        cwd: projectRoot,
        env,
        encoding: 'utf8',
        maxBuffer: 1024 * 1024,
        timeout: 60_000,
        windowsHide: true
      },
      (error, stdout, stderr) => {
        const output = `${stdout}${stderr}`
        process.stdout.write(output)
        process.stdout.write(`runner elapsed: ${Date.now() - startedAt}ms\n`)
        if (error) {
          rejectRun(new Error(`${error.message}\n${output}`))
          return
        }
        resolveRun(output)
      }
    )
  })
}

test('识别 Windows 原生模块 unlink 文件锁', () => {
  assert.equal(
    classifyL4PiPackageMaintenanceFailure(
      "EPERM: operation not permitted, unlink 'C:\\agent\\npm\\cpufeatures.node'"
    ),
    'locked'
  )
})

test('识别跨平台 busy 文件锁', () => {
  assert.equal(classifyL4PiPackageMaintenanceFailure('EBUSY: resource busy or locked'), 'locked')
  assert.equal(classifyL4PiPackageMaintenanceFailure('ETXTBSY: text file busy'), 'locked')
})

test('网络和普通权限错误不借重启重试', () => {
  assert.equal(classifyL4PiPackageMaintenanceFailure('npm ERR! code E404'), 'failed')
  assert.equal(
    classifyL4PiPackageMaintenanceFailure('EACCES: permission denied, open config'),
    'failed'
  )
})

test('生产 runner 用普通 Node 通过真实 Pi CLI 安装和删除隔离本地包', async () => {
  const fixtureRoot = process.env.L4_PACKAGE_MAINTENANCE_FIX_ROOT
  const agentDir = process.env.PI_CODING_AGENT_DIR
  assert.ok(fixtureRoot, '缺少本次运行的临时 fixture 根目录')
  assert.ok(agentDir, 'Pi agent 目录必须由当前隔离运行显式提供')
  assert.match(fixtureRoot.replaceAll('\\', '/'), /\/temp\/tests\/plugin-maintenance-fix\//)
  assert.match(
    agentDir.replaceAll('\\', '/'),
    /\/temp\/pi\/l4-package-maintenance-fix\/[^/]+\/agent$/
  )

  const sourceDir = join(fixtureRoot, 'fixture-package')
  const sourceFile = join(sourceDir, 'extensions/maintenance-fixture.mjs')
  const source = sourceDir
  const explicitCwd = join(fixtureRoot, 'explicit-maintenance-cwd')
  const defaultCwd = join(agentDir, 'pi-desk/plugin-package-manager')
  mkdirSync(join(sourceDir, 'extensions'), { recursive: true })
  writeFileSync(
    join(sourceDir, 'package.json'),
    JSON.stringify({ name: 'pi-desk-maintenance-fixture', private: true })
  )
  writeFileSync(sourceFile, 'export default function fixture() {}\n')

  try {
    const explicitInstallOutput = await runRunner('install', source, agentDir, explicitCwd)
    assert.doesNotMatch(explicitInstallOutput, /server-only|ERR_PACKAGE_PATH_NOT_EXPORTED/i)
    assert.ok(hasConfiguredSource(agentDir, source))
    assert.ok(existsSync(explicitCwd))
    assert.equal(existsSync(defaultCwd), false)

    const explicitRemoveOutput = await runRunner('remove', source, agentDir, explicitCwd)
    assert.doesNotMatch(explicitRemoveOutput, /server-only|ERR_PACKAGE_PATH_NOT_EXPORTED/i)
    assert.equal(hasConfiguredSource(agentDir, source), false)
    assert.ok(existsSync(sourceFile))

    const defaultInstallOutput = await runRunner('install', source, agentDir)
    assert.doesNotMatch(defaultInstallOutput, /server-only|ERR_PACKAGE_PATH_NOT_EXPORTED/i)
    assert.ok(hasConfiguredSource(agentDir, source))
    assert.ok(existsSync(defaultCwd))

    const defaultRemoveOutput = await runRunner('remove', source, agentDir)
    assert.doesNotMatch(defaultRemoveOutput, /server-only|ERR_PACKAGE_PATH_NOT_EXPORTED/i)
    assert.equal(hasConfiguredSource(agentDir, source), false)
    assert.ok(existsSync(sourceFile))
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true })
    rmSync(agentDir, { recursive: true, force: true })
  }
})
