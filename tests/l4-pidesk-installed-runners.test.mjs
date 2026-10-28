import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { cp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'
import { terminateManagedTree } from '../src/server/l4_foundation/process/l4-process-tree.js'

const execute = promisify(execFile)
const projectRoot = resolve(import.meta.dirname, '..')
// 工作截止后仍等待原生终止（最多 30 秒）、输出关闭和现场记录，不由整项测试超时承担清理。
const finalizationBudget = 30_000 + 5_000 + 5_000
const hostWorkBudget = 80_000
const externalWorkBudget = 2 * 30_000

async function withInstalledFixture(profile, workBudget, check) {
  const root = join(projectRoot, 'temp/run/pidesk-installed', `${profile}-${randomUUID()}`)
  const host = join(root, '应用目录 with spaces/node_modules/@jetcrab/pi-desk')
  const agentDir = join(root, 'agent')
  const cwd = join(root, 'project')
  const plugin = join(root, 'fixture-plugin')
  let passed = false
  const deadline = performance.now() + workBudget
  const executeOwned = async (args, options, limitMs = workBudget) => {
    const remaining = Math.floor(Math.min(limitMs, deadline - performance.now()))
    assert.ok(remaining > 0, '安装态辅助进程共享工作预算已耗尽')
    const command = execute(process.execPath, args, {
      ...options,
      windowsHide: true,
      detached: process.platform !== 'win32'
    })
    let timer
    let closeTimer
    try {
      return await Promise.race([
        command,
        new Promise((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                Object.assign(new Error('安装态辅助进程工作预算已耗尽'), { code: 'ETIMEDOUT' })
              ),
            remaining
          )
        })
      ])
    } catch (error) {
      try {
        await terminateManagedTree(command.child)
        const result = await Promise.race([
          command.catch((failure) => failure),
          new Promise((_, reject) => {
            closeTimer = setTimeout(
              () => reject(new Error('辅助进程树终止后输出通道未关闭')),
              5_000
            )
          })
        ])
        error.stdout = result.stdout
        error.stderr = result.stderr
      } catch (cleanupError) {
        console.error('辅助进程释放失败', cleanupError)
        error.cleanupError = cleanupError
      }
      throw error
    } finally {
      clearTimeout(timer)
      clearTimeout(closeTimer)
    }
  }
  try {
    await Promise.all([
      mkdir(host, { recursive: true }),
      mkdir(cwd, { recursive: true }),
      mkdir(plugin, { recursive: true })
    ])
    for (const file of ['src', 'package.json', 'tsconfig.json', 'tsconfig.base.json']) {
      await cp(join(projectRoot, file), join(host, file), { recursive: true })
    }
    await symlink(
      join(projectRoot, 'node_modules'),
      join(host, 'node_modules'),
      process.platform === 'win32' ? 'junction' : 'dir'
    )
    await writeFile(
      join(plugin, 'package.json'),
      JSON.stringify({
        name: 'pidesk-runner-fixture',
        version: '1.0.0',
        type: 'module',
        pi: { extensions: ['./index.mjs'] },
        piDesk: { entry: './pi-desk.mjs' }
      })
    )
    await writeFile(
      join(plugin, 'index.mjs'),
      `export default function (pi) {
      pi.registerTool({ name: 'pidesk_runner_fixture', label: 'Fixture', description: 'Fixture runner tool',
        parameters: { type: 'object', properties: {} },
        async execute() { return { content: [{ type: 'text', text: 'fixture' }] } }
      })
    }\n`
    )
    await writeFile(
      join(plugin, 'pi-desk.mjs'),
      `export default { name: 'pidesk-runner-fixture', setup() {} }\n`
    )
    const environment = {
      ...process.env,
      NODE_ENV: 'production',
      PI_OFFLINE: '1',
      PI_DESK_PI_PACKAGE_DIR: join(projectRoot, 'node_modules/@earendil-works/pi-coding-agent'),
      PI_CODING_AGENT_DIR: agentDir,
      PI_CODING_AGENT_SESSION_DIR: join(agentDir, 'sessions'),
      TSX_TSCONFIG_PATH: join(host, 'tsconfig.json'),
      NODE_OPTIONS: ''
    }
    await check({ host, agentDir, cwd, plugin, environment, executeOwned })
    passed = true
  } catch (error) {
    const detail = [
      `code=${error.code ?? 'null'} signal=${error.signal ?? 'null'} killed=${error.killed ?? false}`,
      String(error.stack ?? error),
      error.cleanupError?.stack ?? '',
      error.stdout ?? '',
      error.stderr ?? ''
    ].join('\n')
    console.error(detail)
    await writeFile(join(root, 'failure.log'), detail)
    throw error
  } finally {
    if (passed) await rm(root, { recursive: true, force: true })
    else console.error(`安装态辅助进程失败现场：${root}`)
  }
}

test(
  '安装到 node_modules 后维护、候选预检和能力查询共用可运行的辅助进程',
  { timeout: hostWorkBudget + finalizationBudget },
  async () => {
    await withInstalledFixture(
      'installed-runners-host',
      hostWorkBudget,
      async ({ host, cwd, plugin, environment, executeOwned }) => {
        const harness = join(host, 'runner-check.mjs')
        await writeFile(
          harness,
          `
      import assert from 'node:assert/strict'
      import { readFile } from 'node:fs/promises'
      import { dirname, join, resolve } from 'node:path'
      import { createRequire } from 'node:module'
      import { createJiti } from 'jiti'
      const require = createRequire(import.meta.url)
      const jiti = createJiti(import.meta.url, { tsconfigPaths: join(process.cwd(), 'tsconfig.json'),
        alias: { 'server-only': join(dirname(require.resolve('server-only')), 'empty.js') },
        nativeModules: ['@earendil-works/pi-coding-agent', '@earendil-works/pi-agent-core', '@earendil-works/pi-ai'] })
      const started = Date.now()
      const stage = label => console.log('[安装态辅助进程] ' + label + '，累计 ' + (Date.now() - started) + 'ms')
      stage('加载维护模块')
      const { runL4PiPackageMaintenance: maintain } = await jiti.import('./src/server/l4_foundation/pi/l4-pi-package-maintenance.ts')
      const input = { agentDir: process.env.PI_CODING_AGENT_DIR, cwd: ${JSON.stringify(cwd)} }
      const source = ${JSON.stringify(plugin)}
      stage('安装插件')
      await maintain({ ...input, maintenance: { action: 'install', source } })
      const settings = () => readFile(join(input.agentDir, 'settings.json'), 'utf8').then(JSON.parse)
      assert.ok((await settings()).packages.some(value => resolve(input.agentDir, value) === source))
      stage('候选预检')
      const { runL4PiPluginProbe: probe } = await jiti.import('./src/server/l4_foundation/pi/l4-pi-plugin-probe.ts')
      const result = await probe(input.cwd, input.agentDir, true)
      assert.equal(result.loadError, null)
      assert.equal(result.packages[0].status, 'ready')
      stage('能力查询')
      const { runL4PiPluginCapabilityProbe: capabilities } = await jiti.import('./src/server/l4_foundation/pi/l4-pi-plugin-capability-probe.ts')
      const detail = await capabilities(input.cwd, input.agentDir)
      assert.equal(detail.loadError, null)
      assert.deepEqual(detail.packages[0].tools.map(tool => tool.name), ['pidesk_runner_fixture'])
      stage('移除插件')
      await maintain({ ...input, maintenance: { action: 'remove', source } })
      assert.deepEqual((await settings()).packages, [])
      stage('验证完成')
      console.log('INSTALLED_RUNNERS_OK')
    `
        )
        const result = await executeOwned(
          [
            '--conditions=react-server',
            '--import',
            pathToFileURL(join(host, 'src/server/l4_foundation/pi/l4-pi-runtime-register.mjs'))
              .href,
            '--import',
            'tsx',
            harness
          ],
          { cwd: host, env: environment }
        )
        console.info(result.stdout.trim())
        assert.match(result.stdout, /INSTALLED_RUNNERS_OK/)
      }
    )
  }
)

test(
  '安装态维护 runner 从外部 cwd 调用时使用宿主运行时并完成安装和移除',
  { timeout: externalWorkBudget + finalizationBudget },
  async () => {
    await withInstalledFixture(
      'installed-runners-external',
      externalWorkBudget,
      async ({ host, agentDir, cwd, plugin, environment, executeOwned }) => {
        await writeFile(join(cwd, 'tsconfig.json'), '{}')
        const runner = join(
          host,
          'src/server/l4_foundation/pi/l4-pi-package-maintenance-runner.mts'
        )
        for (const action of ['install', 'remove']) {
          await executeOwned(
            [
              '--import',
              pathToFileURL(join(host, 'src/server/l4_foundation/pi/l4-pi-runtime-register.mjs'))
                .href,
              '--import',
              'tsx',
              runner,
              action,
              plugin
            ],
            {
              cwd,
              env: { ...environment, TSX_TSCONFIG_PATH: join(cwd, 'tsconfig.json') }
            },
            30_000
          )
        }
        assert.deepEqual(
          JSON.parse(await readFile(join(agentDir, 'settings.json'), 'utf8')).packages,
          []
        )
      }
    )
  }
)
