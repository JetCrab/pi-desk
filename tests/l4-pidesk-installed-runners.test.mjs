import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { cp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'

const execute = promisify(execFile)
const projectRoot = resolve(import.meta.dirname, '..')

test(
  '安装到 node_modules 后维护、候选预检和能力查询共用可运行的辅助进程',
  { timeout: 90_000 },
  async () => {
    const id = `installed-runners-${randomUUID()}`
    const root = join(projectRoot, 'temp/run/pidesk-installed', id)
    const host = join(root, '应用目录 with spaces/node_modules/@jetcrab/pi-desk')
    const agentDir = join(root, 'agent')
    const cwd = join(root, 'project')
    const plugin = join(root, 'fixture-plugin')
    let passed = false
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
      const { runL4PiPackageMaintenance: maintain } = await jiti.import('./src/server/l4_foundation/pi/l4-pi-package-maintenance.ts')
      const input = { agentDir: process.env.PI_CODING_AGENT_DIR, cwd: ${JSON.stringify(cwd)} }
      const source = ${JSON.stringify(plugin)}
      await maintain({ ...input, maintenance: { action: 'install', source } })
      const settings = () => readFile(join(input.agentDir, 'settings.json'), 'utf8').then(JSON.parse)
      assert.ok((await settings()).packages.some(value => resolve(input.agentDir, value) === source))
      const { runL4PiPluginProbe: probe } = await jiti.import('./src/server/l4_foundation/pi/l4-pi-plugin-probe.ts')
      const result = await probe(input.cwd, input.agentDir, true)
      assert.equal(result.loadError, null)
      assert.equal(result.packages[0].status, 'ready')
      const { runL4PiPluginCapabilityProbe: capabilities } = await jiti.import('./src/server/l4_foundation/pi/l4-pi-plugin-capability-probe.ts')
      const detail = await capabilities(input.cwd, input.agentDir)
      assert.equal(detail.loadError, null)
      assert.deepEqual(detail.packages[0].tools.map(tool => tool.name), ['pidesk_runner_fixture'])
      await maintain({ ...input, maintenance: { action: 'remove', source } })
      assert.deepEqual((await settings()).packages, [])
      console.log('INSTALLED_RUNNERS_OK')
    `
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
      const result = await execute(
        process.execPath,
        [
          '--conditions=react-server',
          '--import',
          pathToFileURL(join(host, 'src/server/l4_foundation/pi/l4-pi-runtime-register.mjs')).href,
          '--import',
          'tsx',
          harness
        ],
        {
          cwd: host,
          timeout: 80_000,
          windowsHide: true,
          env: environment
        }
      )
      assert.match(result.stdout, /INSTALLED_RUNNERS_OK/)
      await writeFile(join(cwd, 'tsconfig.json'), '{}')
      const runner = join(host, 'src/server/l4_foundation/pi/l4-pi-package-maintenance-runner.mts')
      for (const action of ['install', 'remove']) {
        await execute(
          process.execPath,
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
            timeout: 30_000,
            windowsHide: true,
            env: { ...environment, TSX_TSCONFIG_PATH: join(cwd, 'tsconfig.json') }
          }
        )
      }
      assert.deepEqual(
        JSON.parse(await readFile(join(agentDir, 'settings.json'), 'utf8')).packages,
        []
      )
      passed = true
    } catch (error) {
      await writeFile(
        join(root, 'failure.log'),
        String(error.stack ?? error) + '\n' + (error.stdout ?? '') + '\n' + (error.stderr ?? '')
      )
      throw error
    } finally {
      if (passed) await rm(root, { recursive: true, force: true })
      else console.error(`安装态辅助进程失败现场：${root}`)
    }
  }
)
