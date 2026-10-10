import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import test, { before } from 'node:test'
import { createJiti } from 'jiti'
import type {
  L2PluginManagementBatchRequest,
  L2PluginManagementBatchResponse,
  L2PluginManagementInstallRequest,
  L2PluginManagementListRequest,
  L2PluginManagementOperation,
  L2PluginManagementSnapshot
} from '../src/common/l2_biz/plugin/l2-plugin-management-contract'

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
let Management: (typeof import('../src/server/l2_biz/plugin-management/l2-plugin-management'))['L2PluginManagement']
before(async () => {
  const saved = process.env.PI_DESK_SAFE_MODE
  delete process.env.PI_DESK_SAFE_MODE
  try {
    const commands = await jiti.import<
      typeof import('../src/server/l2_biz/plugin-management/l2-plugin-commands')
    >('../src/server/l2_biz/plugin-management/l2-plugin-commands.ts')
    execute = commands.executeL2PluginCommand
    const management = await jiti.import<
      typeof import('../src/server/l2_biz/plugin-management/l2-plugin-management')
    >('../src/server/l2_biz/plugin-management/l2-plugin-management.ts')
    Management = management.L2PluginManagement
  } finally {
    if (saved === undefined) delete process.env.PI_DESK_SAFE_MODE
    else process.env.PI_DESK_SAFE_MODE = saved
  }
})

test(
  '管理队列观察等待应用和收尾，失败、重启要求与关闭均释放等待',
  { timeout: 20_000 },
  async () => {
    const root = resolve('temp/pi/pidesk-completion', `queue-${randomUUID()}`)
    const agentDir = join(root, 'agent')
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR
    const previousSessionDir = process.env.PI_CODING_AGENT_SESSION_DIR
    await mkdir(agentDir, { recursive: true })
    process.env.PI_CODING_AGENT_DIR = agentDir
    process.env.PI_CODING_AGENT_SESSION_DIR = join(agentDir, 'sessions')
    let management: InstanceType<typeof Management> | undefined
    let succeeded = false
    try {
      management = new Management(
        {
          refreshPluginMessages: () => undefined,
          runPluginRestart: (operation) => operation()
        },
        root,
        agentDir
      )
      const operations = Reflect.get(management, 'operations') as Map<
        string,
        L2PluginManagementOperation
      >
      const publish = (): void => {
        Reflect.apply(Reflect.get(management!, 'publish'), management, [])
      }
      const source = 'npm:completion-fixture'
      const signal = new AbortController().signal
      operations.set(source, { action: 'apply', phase: 'applying', message: null })
      let completed = false
      const waiting = management.waitForOperations([source], signal).then(() => {
        completed = true
      })
      operations.delete(source)
      Reflect.set(management, 'activeSource', source)
      publish()
      await Promise.resolve()
      assert.equal(completed, false, '仍在收尾时不能报告完成')
      Reflect.set(management, 'activeSource', null)
      publish()
      await waiting
      assert.equal(completed, true)
      operations.set(source, { action: 'apply', phase: 'failed', message: '候选预检失败' })
      await assert.rejects(() => management!.waitForOperations([source], signal), /候选预检失败/)
      operations.set(source, { action: 'update', phase: 'waiting', message: '包文件被占用' })
      const deferred = Reflect.get(management, 'deferredMaintenance') as Map<string, unknown>
      deferred.set(source, { action: 'update', source })
      await assert.rejects(() => management!.waitForOperations([source], signal), /尚未生效.*重启/)
      deferred.clear()
      operations.set(source, { action: 'add', phase: 'queued', message: null })
      const controller = new AbortController()
      const aborted = management.waitForOperations([source], controller.signal)
      controller.abort()
      await assert.rejects(aborted, /会话已关闭/)
      const closing = management.waitForOperations([source], signal)
      management.dispose()
      await assert.rejects(closing, /插件管理已关闭/)
      const listeners = Reflect.get(management, 'listeners') as Set<() => void>
      assert.equal(listeners.size, 0)
      succeeded = true
    } finally {
      management?.dispose()
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir
      if (previousSessionDir === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR
      else process.env.PI_CODING_AGENT_SESSION_DIR = previousSessionDir
      if (succeeded) await rm(root, { recursive: true, force: true })
    }
  }
)

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
  lastListInput: boolean | L2PluginManagementListRequest = false
  rejected = new Map<string, string>()
  waiting = new Map<string, Promise<void>>()
  private resolveCompletion!: () => void
  private rejectCompletion!: (error: Error) => void
  readonly completion = new Promise<void>((resolvePromise, rejectPromise) => {
    this.resolveCompletion = resolvePromise
    this.rejectCompletion = rejectPromise
  })

  async list(
    input: boolean | L2PluginManagementListRequest = false
  ): Promise<L2PluginManagementSnapshot> {
    this.lastListInput = input
    return this.state
  }
  async batch(input: L2PluginManagementBatchRequest): Promise<L2PluginManagementBatchResponse> {
    this.calls.push(['batch', input])
    const sources = input.action === 'add' ? input.items.map((item) => item.source) : input.sources
    return {
      snapshot: this.state,
      results: sources.map((source) => ({ source, error: this.rejected.get(source) ?? null }))
    }
  }
  async get(source: string) {
    return { source, readme: null, tools: [], skills: [], prompts: [] }
  }
  async apply(sources?: readonly string[]): Promise<L2PluginManagementSnapshot> {
    this.calls.push(['apply', sources])
    for (const source of sources ?? []) {
      const error = this.rejected.get(source)
      if (error) throw new Error(error)
    }
    return this.state
  }
  async reinstall(
    source: string,
    previous?: string,
    options?: Omit<L2PluginManagementInstallRequest, 'source'>
  ): Promise<L2PluginManagementSnapshot> {
    this.calls.push(['reinstall', source, previous, ...(options ? [options] : [])])
    return this.state
  }
  async del(source: string): Promise<L2PluginManagementSnapshot> {
    this.calls.push(['del', source])
    return this.state
  }
  waitForOperations(sources: readonly string[], _signal: AbortSignal): Promise<void> {
    this.calls.push(['wait', sources])
    return this.waiting.get(sources[0]) ?? this.completion
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
      assert.match(notice.messages[0], /2.0.0.*完成宿主加载/)
      assert.doesNotMatch(notice.messages[0], /已有会话已刷新/)
      assert.match(notice.messages[0], /主动 reload/)
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
      assert.match(notice.messages[0], /已有 Pi 会话.*主动 reload/)
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

    await t.test('重载 npm 和本地来源只应用已安装代码，保留版本且同来源去重', async () => {
      const management = new ManagementFixture()
      const npmSource = management.state.plugins[0].source
      management.state.plugins[0].pluginName = 'fixture-plugin'
      const local = join(agentDir, 'extensions', 'reload-local')
      management.state.plugins.push({
        ...snapshot(local).plugins[0],
        kind: 'extension',
        version: null,
        status: 'available'
      })
      const notice = notificationContext(root)
      const result = await execute(
        {
          kind: 'plugins',
          action: 'reload',
          names: ['@fixture/plugin', 'fixture-plugin', 'reload-local']
        },
        notice.context,
        management,
        agentDir
      )
      assert.equal(result.mode, 'async')
      assert.match(result.message, /重载.*已被接纳/)
      assert.equal(notice.messages.length, 0)
      assert.deepEqual(management.calls, [
        ['apply', [npmSource]],
        ['apply', [local]],
        ['wait', [npmSource]],
        ['wait', [local]]
      ])
      management.finish()
      await notice.notification
      assert.equal(notice.messages.length, 1)
      assert.match(notice.messages[0], /成功：已重新加载本机代码/)
      assert.doesNotMatch(notice.messages[0], /已安装|重装|已重启/)
      assert.equal(management.state.plugins[0].source, npmSource)
      assert.equal(management.state.plugins[0].version, '1.0.0')
    })

    await t.test('重载逐项报告拒绝和加载失败，其他目标完成后才汇总', async () => {
      const management = new ManagementFixture()
      const sources = ['one', 'two', 'three'].map((name) => `npm:@fixture/${name}@1.0.0`)
      management.state.plugins = sources.map((source) => snapshot(source).plugins[0])
      management.rejected.set(sources[2], '该来源已有未完成操作')
      let finishSecond!: () => void
      management.waiting.set(
        sources[1],
        new Promise<void>((done) => {
          finishSecond = done
        })
      )
      const notice = notificationContext(root)
      const result = await execute(
        {
          kind: 'plugins',
          action: 'reload',
          names: ['@fixture/one', '@fixture/two', '@fixture/three']
        },
        notice.context,
        management,
        agentDir
      )
      assert.match(result.message, /2\/3/)
      management.fail('候选插件预检失败')
      await new Promise<void>((done) => setImmediate(done))
      assert.equal(notice.messages.length, 0)
      finishSecond()
      await notice.notification
      assert.equal(notice.messages.length, 1)
      assert.match(notice.messages[0], /@fixture\/one：失败.*候选插件预检失败/)
      assert.match(notice.messages[0], /@fixture\/two：成功.*重新加载/)
      assert.match(notice.messages[0], /@fixture\/three：未接纳.*已有未完成操作/)
      assert.ok(management.calls.every(([method]) => method === 'apply' || method === 'wait'))
    })

    await t.test('未知、重名或禁用来源不触发重载，全部拒绝不承诺通知', async () => {
      for (const scenario of ['unknown', 'ambiguous', 'disabled', 'rejected']) {
        const management = new ManagementFixture()
        const notice = notificationContext(root)
        const source = management.state.plugins[0].source
        if (scenario === 'unknown') management.state.plugins = []
        if (scenario === 'ambiguous')
          management.state.plugins.push(snapshot('npm:@fixture/plugin@2.0.0').plugins[0])
        if (scenario === 'disabled') management.state.plugins[0].status = 'disabled'
        if (scenario === 'rejected') management.rejected.set(source, '插件管理正在关闭')
        await assert.rejects(
          execute(
            { kind: 'plugins', action: 'reload', name: '@fixture/plugin' },
            notice.context,
            management,
            agentDir
          ),
          scenario === 'unknown'
            ? /不存在/
            : scenario === 'ambiguous'
              ? /多个来源/
              : scenario === 'disabled'
                ? /禁用/
                : /正在关闭/
        )
        assert.deepEqual(management.calls, scenario === 'rejected' ? [['apply', [source]]] : [])
        assert.equal(notice.messages.length, 0)
      }
    })

    await t.test('重载完成时检查加载错误，会话关闭不再投递通知', async () => {
      for (const scenario of ['failed', 'closed']) {
        const management = new ManagementFixture()
        const notice = notificationContext(root)
        await execute(
          { kind: 'plugins', action: 'reload', name: '@fixture/plugin' },
          notice.context,
          management,
          agentDir
        )
        if (scenario === 'failed') {
          management.state.plugins[0].error = { phase: 'setup', message: '新版入口加载失败' }
          management.state.plugins[0].status = 'failed'
          management.finish()
          await notice.notification
          assert.match(notice.messages[0], /失败.*新版入口加载失败/)
          assert.doesNotMatch(notice.messages[0], /成功：/)
        } else {
          notice.controller.abort()
          management.finish()
          await new Promise<void>((done) => setImmediate(done))
          assert.equal(notice.messages.length, 0)
        }
      }
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

    await t.test('批量部分拒绝不提前通知，全部接纳项收尾后只汇总一次', async () => {
      const management = new ManagementFixture()
      management.state.plugins = ['one', 'two', 'three'].map((name) => ({
        ...snapshot(`npm:@fixture/${name}@1.0.0`).plugins[0],
        updateTag: 'dev'
      }))
      management.rejected.set('npm:@fixture/three', '已有操作正在执行')
      let finishSecond!: () => void
      management.waiting.set(
        'npm:@fixture/two',
        new Promise<void>((done) => {
          finishSecond = done
        })
      )
      const notice = notificationContext(root)
      const result = await execute(
        {
          kind: 'plugins',
          action: 'install',
          names: ['@fixture/one', '@fixture/two', '@fixture/three'],
          tag: 'dev'
        },
        notice.context,
        management,
        agentDir
      )
      assert.equal(result.mode, 'async')
      assert.deepEqual(management.calls[0], [
        'batch',
        {
          action: 'add',
          items: ['one', 'two', 'three'].map((name) => ({
            source: `npm:@fixture/${name}`,
            tag: 'dev'
          }))
        }
      ])
      management.fail('第一个包预检失败')
      await new Promise<void>((done) => setImmediate(done))
      assert.equal(notice.messages.length, 0, '尚有已接纳包在执行时不应通知整批完成')
      finishSecond()
      await notice.notification
      assert.equal(notice.messages.length, 1)
      assert.match(notice.messages[0], /@fixture\/one：失败.*预检失败/)
      assert.match(notice.messages[0], /@fixture\/two：成功/)
      assert.match(notice.messages[0], /@fixture\/three：未接纳.*已有操作/)
    })

    await t.test('纯原生包不需要创建已有会话才能报告安装完成', async () => {
      const management = new ManagementFixture()
      management.state.plugins[0].status = 'available'
      const notice = notificationContext(root)
      await execute(
        { kind: 'plugins', action: 'install', name: '@fixture/plugin' },
        notice.context,
        management,
        agentDir
      )
      management.finish()
      await notice.notification
      assert.match(notice.messages[0], /成功：已安装/)
    })

    await t.test('单包标签安装与仅dev检查复用管理业务，不猜测版本后缀', async () => {
      const management = new ManagementFixture()
      management.state.plugins[0].updateTag = 'dev'
      management.state.plugins[0].availableVersion = '1.0.1-dev.2'
      management.state.plugins.push({
        ...snapshot('npm:@fixture/stable@1.0.0').plugins[0],
        updateTag: 'latest'
      })
      const notice = notificationContext(root)
      const listed = await execute(
        { kind: 'plugins', action: 'list', checkUpdates: true, tag: 'dev' },
        notice.context,
        management,
        agentDir
      )
      assert.deepEqual(management.lastListInput, { checkUpdates: true, tag: 'dev' })
      assert.equal(JSON.parse(listed.message).plugins.length, 1)
      assert.equal(JSON.parse(listed.message).plugins[0].availableVersion, '1.0.1-dev.2')
      await execute(
        { kind: 'plugins', action: 'install', name: '@fixture/plugin', tag: 'dev' },
        notice.context,
        management,
        agentDir
      )
      assert.deepEqual(management.calls[0], [
        'reinstall',
        'npm:@fixture/plugin',
        'npm:@fixture/plugin@1.0.0',
        { tag: 'dev' }
      ])
      management.finish()
      await notice.notification
      assert.match(notice.messages[0], /成功/)
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
