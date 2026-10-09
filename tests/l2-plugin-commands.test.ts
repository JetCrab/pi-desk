import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import test, { before } from 'node:test'
import { createJiti } from 'jiti'
import type { L2PluginManagementSnapshot } from '../src/common/l2_biz/plugin/l2-plugin-management-contract'

const require = createRequire(import.meta.url)
const jiti = createJiti(import.meta.url, {
  moduleCache: true,
  nativeModules: [
    '@earendil-works/pi-coding-agent',
    '@earendil-works/pi-agent-core',
    '@earendil-works/pi-ai'
  ],
  tsconfigPaths: join(process.cwd(), 'tsconfig.json'),
  alias: { 'server-only': join(dirname(require.resolve('server-only')), 'empty.js') }
})

let execute: (typeof import('../src/server/l2_biz/plugin-management/l2-plugin-commands'))['executeL2PluginCommand']
before(async () => {
  const saved = process.env.PI_DESK_SAFE_MODE
  delete process.env.PI_DESK_SAFE_MODE
  try {
    const commands = await jiti.import<
      typeof import('../src/server/l2_biz/plugin-management/l2-plugin-commands')
    >('../src/server/l2_biz/plugin-management/l2-plugin-commands.ts')
    execute = commands.executeL2PluginCommand
  } finally {
    if (saved === undefined) delete process.env.PI_DESK_SAFE_MODE
    else process.env.PI_DESK_SAFE_MODE = saved
  }
})

function emptyCapabilities() {
  return {
    error: null,
    extensions: [],
    tools: [],
    skills: [],
    prompts: [],
    themes: [],
    providers: [],
    piDesk: { methods: [], browserEntries: [], messageDeclarations: [] }
  }
}

function snapshot(source = 'npm:@fixture/plugin@1.0.0'): L2PluginManagementSnapshot {
  return {
    plugins: [
      {
        source,
        kind: 'package',
        operation: null,
        pluginName: null,
        description: null,
        version: '1.0.0',
        updateAvailable: null,
        status: 'ready',
        error: null,
        capabilities: emptyCapabilities()
      }
    ],
    restartRequired: false,
    loadError: null
  }
}

class ManagementFixture {
  state = snapshot()
  calls: unknown[][] = []
  private resolveCompletion!: () => void
  private rejectCompletion!: (error: Error) => void
  readonly completion = new Promise<void>((resolvePromise, rejectPromise) => {
    this.resolveCompletion = resolvePromise
    this.rejectCompletion = rejectPromise
  })

  async list(): Promise<L2PluginManagementSnapshot> {
    return this.state
  }
  async get(source: string) {
    return { source, readme: null, tools: [], skills: [], prompts: [] }
  }
  async apply(sources?: readonly string[]): Promise<L2PluginManagementSnapshot> {
    this.calls.push(['apply', sources])
    return this.state
  }
  async reinstall(source: string, previous?: string): Promise<L2PluginManagementSnapshot> {
    this.calls.push(['reinstall', source, previous])
    return this.state
  }
  async del(source: string): Promise<L2PluginManagementSnapshot> {
    this.calls.push(['del', source])
    return this.state
  }
  waitForOperations(sources: readonly string[], _signal: AbortSignal): Promise<void> {
    this.calls.push(['wait', sources])
    return this.completion
  }
  finish(): void {
    this.resolveCompletion()
  }
  fail(message: string): void {
    this.rejectCompletion(new Error(message))
  }
}

function notificationContext(cwd: string) {
  const controller = new AbortController()
  const messages: string[] = []
  let notified!: () => void
  const notification = new Promise<void>((resolveNotice) => {
    notified = resolveNotice
  })
  return {
    controller,
    messages,
    notification,
    context: {
      cwd,
      signal: controller.signal,
      async notify(message: string): Promise<void> {
        messages.push(message)
        notified()
      }
    }
  }
}

test('插件命令接纳、应用和结果通知', { timeout: 30_000 }, async (t) => {
  const root = resolve('temp/pi/pidesk-commands', `business-${randomUUID()}`)
  const agentDir = join(root, 'agent')
  await mkdir(join(agentDir, 'extensions'), { recursive: true })
  const saved = process.env.PI_DESK_SAFE_MODE
  delete process.env.PI_DESK_SAFE_MODE
  let succeeded = false
  try {
    await t.test('查询同步返回，npm 最新安装解除原有固定版本并等待完成', async () => {
      const management = new ManagementFixture()
      const notice = notificationContext(root)
      const listed = await execute(
        { kind: 'plugins', action: 'list' },
        notice.context,
        management,
        agentDir
      )
      assert.equal(listed.mode, 'sync')
      assert.match(listed.message, /@fixture\/plugin/)
      assert.equal(listed.message.includes('\n'), false)
      assert.deepEqual(JSON.parse(listed.message), {
        plugins: [
          {
            name: '@fixture/plugin',
            source: 'npm:@fixture/plugin@1.0.0',
            kind: 'package',
            version: '1.0.0',
            status: 'ready'
          }
        ],
        restartRequired: false
      })
      const shown = await execute(
        { kind: 'plugins', action: 'show', name: '@fixture/plugin' },
        notice.context,
        management,
        agentDir
      )
      assert.equal(shown.message.includes('\n'), false)
      assert.deepEqual(JSON.parse(shown.message).detail, { tools: [], skills: [], prompts: [] })
      const result = await execute(
        { kind: 'plugins', action: 'install', name: '@fixture/plugin' },
        notice.context,
        management,
        agentDir
      )
      assert.equal(result.mode, 'async')
      assert.match(result.message, /已被接纳/)
      assert.deepEqual(management.calls[0], [
        'reinstall',
        'npm:@fixture/plugin',
        'npm:@fixture/plugin@1.0.0'
      ])
      assert.equal(notice.messages.length, 0)
      management.state.plugins[0].source = 'npm:@fixture/plugin'
      management.state.plugins[0].version = '2.0.0'
      management.finish()
      await notice.notification
      assert.match(notice.messages[0], /2.0.0.*完成加载/)
      assert.match(notice.messages[0], /已有会话已刷新/)
    })

    await t.test('查询保留未知版本、零插件、异常和重启要求', async () => {
      const management = new ManagementFixture()
      const notice = notificationContext(root)
      management.state.plugins[0].version = null
      management.state.plugins[0].operation = {
        action: 'apply',
        phase: 'failed',
        message: '加载失败'
      }
      management.state.plugins[0].error = { phase: 'setup', message: '初始化失败' }
      management.state.restartRequired = true
      management.state.loadError = '需要重启'
      const listed = JSON.parse(
        (await execute({ kind: 'plugins', action: 'list' }, notice.context, management, agentDir))
          .message
      )
      assert.equal(listed.plugins[0].version, null)
      assert.deepEqual(listed.plugins[0].operation, management.state.plugins[0].operation)
      assert.deepEqual(listed.plugins[0].error, management.state.plugins[0].error)
      assert.equal(listed.restartRequired, true)
      assert.equal(listed.loadError, '需要重启')
      management.state.plugins = []
      assert.deepEqual(
        JSON.parse(
          (await execute({ kind: 'plugins', action: 'list' }, notice.context, management, agentDir))
            .message
        ).plugins,
        []
      )
    })

    await t.test('失败的版本尝试不遮挡当前已安装来源', async () => {
      const management = new ManagementFixture()
      management.state.plugins.push({
        ...management.state.plugins[0],
        source: 'npm:@fixture/plugin@9.0.0',
        version: null,
        status: 'failed',
        operation: { action: 'add', phase: 'failed', message: '版本不存在' }
      })
      const notice = notificationContext(root)
      await execute(
        { kind: 'plugins', action: 'install', name: '@fixture/plugin', version: '1.0.0' },
        notice.context,
        management,
        agentDir
      )
      assert.deepEqual(management.calls[0], [
        'reinstall',
        'npm:@fixture/plugin@1.0.0',
        'npm:@fixture/plugin@1.0.0'
      ])
      management.finish()
      await notice.notification
      assert.match(notice.messages[0], /已安装 1.0.0/)
    })

    await t.test('指定版本必须与实际版本一致，失败不能报告成功', async () => {
      const management = new ManagementFixture()
      const notice = notificationContext(root)
      await execute(
        { kind: 'plugins', action: 'install', name: '@fixture/plugin', version: '3.1.0' },
        notice.context,
        management,
        agentDir
      )
      assert.equal(management.calls[0][1], 'npm:@fixture/plugin@3.1.0')
      management.finish()
      await notice.notification
      assert.match(notice.messages[0], /实际版本.*不一致/)
      assert.doesNotMatch(notice.messages[0], /完成加载/)
    })

    await t.test('同版本也调用重新安装，完成前不通知成功', async () => {
      const management = new ManagementFixture()
      const notice = notificationContext(root)
      await execute(
        { kind: 'plugins', action: 'install', name: '@fixture/plugin', version: '1.0.0' },
        notice.context,
        management,
        agentDir
      )
      assert.equal(management.calls[0][0], 'reinstall')
      management.finish()
      await notice.notification
      assert.match(notice.messages[0], /已安装 1.0.0/)
    })

    await t.test('本地开发使用现有 apply，不执行 npm 安装', async () => {
      const local = join(agentDir, 'extensions', 'local-plugin')
      await mkdir(local)
      await writeFile(join(local, 'index.ts'), 'export default function () {}\n')
      const management = new ManagementFixture()
      management.state = snapshot(local)
      management.state.plugins[0].kind = 'extension'
      const notice = notificationContext(root)
      await assert.rejects(
        () =>
          execute(
            { kind: 'plugins', action: 'install', name: 'local-plugin', version: '1.0.0' },
            notice.context,
            management,
            agentDir
          ),
        /本地插件/
      )
      assert.equal(management.calls.length, 0)
      await execute(
        { kind: 'plugins', action: 'install', name: 'local-plugin' },
        notice.context,
        management,
        agentDir
      )
      assert.deepEqual(management.calls[0], ['apply', [local]])
      management.finish()
      await notice.notification
      assert.match(notice.messages[0], /服务与界面已更新/)
      assert.match(notice.messages[0], /已有会话请重载/)
      await assert.rejects(
        () =>
          execute(
            { kind: 'plugins', action: 'remove', name: 'local-plugin' },
            notice.context,
            management,
            agentDir
          ),
        /不支持卸载裸扩展/
      )
    })

    await t.test('卸载复用 del，确认来源移除后才通知完成', async () => {
      const management = new ManagementFixture()
      const notice = notificationContext(root)
      await execute(
        { kind: 'plugins', action: 'remove', name: '@fixture/plugin' },
        notice.context,
        management,
        agentDir
      )
      assert.deepEqual(management.calls[0], ['del', 'npm:@fixture/plugin@1.0.0'])
      management.state.plugins = []
      management.finish()
      await notice.notification
      assert.match(notice.messages[0], /已卸载/)
    })

    await t.test('维护失败和重启要求使用原错误，不伪装成生效', async () => {
      const management = new ManagementFixture()
      const notice = notificationContext(root)
      await execute(
        { kind: 'plugins', action: 'install', name: '@fixture/plugin' },
        notice.context,
        management,
        agentDir
      )
      management.fail('插件尚未生效，需要重启 Pi Desk')
      await notice.notification
      assert.match(notice.messages[0], /尚未生效，需要重启/)
      assert.doesNotMatch(notice.messages[0], /完成加载/)
    })

    await t.test('发起会话已释放时不再通知，基础模式直接拒绝管理', async () => {
      const management = new ManagementFixture()
      const notice = notificationContext(root)
      await execute(
        { kind: 'plugins', action: 'install', name: '@fixture/plugin' },
        notice.context,
        management,
        agentDir
      )
      notice.controller.abort()
      management.finish()
      await new Promise<void>((resolveImmediate) => setImmediate(resolveImmediate))
      assert.equal(notice.messages.length, 0)
      const script = `
        const assert = require('node:assert/strict')
        const path = require('node:path')
        const { createJiti } = require('jiti')
        const jiti = createJiti(path.join(process.cwd(), 'package.json'), {
          nativeModules: ['@earendil-works/pi-coding-agent', '@earendil-works/pi-agent-core', '@earendil-works/pi-ai'],
          tsconfigPaths: path.join(process.cwd(), 'tsconfig.json'),
          alias: { 'server-only': path.join(path.dirname(require.resolve('server-only')), 'empty.js') }
        })
        jiti.import('./src/server/l2_biz/plugin-management/l2-plugin-commands.ts').then(async ({ executeL2PluginCommand }) => {
          await assert.rejects(() => executeL2PluginCommand(
            { kind: 'plugins', action: 'list' },
            { cwd: process.cwd(), signal: new AbortController().signal, notify: async () => {} },
            {}
          ), /基础模式/)
        }).catch(error => { console.error(error); process.exitCode = 1 })
      `
      await promisify(execFile)(process.execPath, ['-e', script], {
        cwd: process.cwd(),
        timeout: 30_000,
        windowsHide: true,
        env: {
          ...process.env,
          PI_DESK_SAFE_MODE: '1',
          PI_CODING_AGENT_DIR: agentDir,
          PI_CODING_AGENT_SESSION_DIR: join(agentDir, 'sessions')
        }
      })
    })
    succeeded = true
  } finally {
    if (saved === undefined) delete process.env.PI_DESK_SAFE_MODE
    else process.env.PI_DESK_SAFE_MODE = saved
    if (succeeded) await rm(root, { recursive: true, force: true })
  }
})
