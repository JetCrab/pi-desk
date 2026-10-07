import assert from 'node:assert/strict'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { after, before, test } from 'node:test'
import { createJiti } from 'jiti'

type Pi = typeof import('@earendil-works/pi-coding-agent')
type WorkerModule = typeof import('../src/server/l4_foundation/pi/l4-pi-chat-worker')
type Worker = InstanceType<WorkerModule['L4PiChatWorker']>
const root = resolve('temp/pi/l4-pi-native-ui', `native-contract-${process.pid}`)
const agentDir = join(root, 'agent')
const saved = {
  agent: process.env.PI_CODING_AGENT_DIR,
  sessions: process.env.PI_CODING_AGENT_SESSION_DIR,
  safe: process.env.PI_DESK_SAFE_MODE
}
const require = createRequire(import.meta.url)
const jiti = createJiti(import.meta.url, {
  moduleCache: false,
  tsconfigPaths: resolve('tsconfig.json'),
  alias: { 'server-only': join(dirname(require.resolve('server-only')), 'empty.js') }
})
let pi: Pi
let WorkerClass: WorkerModule['L4PiChatWorker']
const workers: Worker[] = []
const managers = new Map<Worker, ReturnType<Pi['SessionManager']['inMemory']>>()

before(async () => {
  await mkdir(join(agentDir, 'extensions'), { recursive: true })
  await mkdir(join(agentDir, 'sessions'), { recursive: true })
  await writeFile(
    join(agentDir, 'settings.json'),
    JSON.stringify({
      defaultProvider: 'ui-fixture',
      defaultModel: 'test',
      defaultProjectTrust: 'yes',
      retry: { enabled: false },
      compaction: { enabled: false }
    })
  )
  await writeFile(
    join(agentDir, 'models.json'),
    JSON.stringify({
      providers: {
        'ui-fixture': {
          baseUrl: 'http://127.0.0.1:9/v1',
          api: 'openai-completions',
          apiKey: 'fixture-only',
          models: [
            {
              id: 'test',
              reasoning: false,
              input: ['text'],
              contextWindow: 8192,
              maxTokens: 128,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
            }
          ]
        }
      }
    })
  )
  await writeFile(
    join(agentDir, 'extensions', 'native-ui.ts'),
    `export default function (pi) {
    pi.on('session_start', async (_, ctx) => {
      ctx.ui.setStatus('mode', ctx.hasUI + '/' + ctx.mode)
      if (ctx.cwd.endsWith('startup')) await ctx.ui.confirm('启动确认', '准备继续')
    })
    pi.registerCommand('ui-check', { handler: async (args, ctx) => {
      let result
      if (args === 'confirm') result = await ctx.ui.confirm('确认', '是否继续')
      if (args === 'input') result = await ctx.ui.input('输入', '占位内容')
      if (args === 'select') result = await ctx.ui.select('选择', ['甲', '乙'])
      if (args === 'editor') result = await ctx.ui.editor('编辑', '第一行\\n第二行')
      if (args === 'sequence') {
        await ctx.ui.confirm('1/4 · 确认', '是否继续')
        await ctx.ui.select('2/4 · 选择', ['甲', '乙'])
        await ctx.ui.input('3/4 · 输入', '名称')
        result = await ctx.ui.editor('4/4 · 编辑', '内容')
      }
      if (args === 'timed') result = await ctx.ui.confirm('限时', '是否继续', { timeout: 10 })
      if (args === 'abort') { const c = new AbortController(); const value = ctx.ui.input('可取消', '', { signal: c.signal }); c.abort(); result = await value }
      if (args === 'parallel') result = await Promise.all([ctx.ui.input('问题一'), ctx.ui.select('问题二', ['甲'])])
      if (args === 'extras') {
        ctx.ui.setStatus('status', '\\x1b[32m准备完成\\x1b[0m')
        ctx.ui.setWidget('上方', ['行一', '行二'])
        ctx.ui.setWidget('下方', ['行三'], { placement: 'belowEditor' })
        ctx.ui.setEditorText('插件草稿')
        ctx.ui.notify('已完成', 'info')
      }
      if (args === 'clear') { ctx.ui.setStatus('status', undefined); ctx.ui.setWidget('上方', undefined); ctx.ui.setWidget('下方', undefined) }
      ctx.ui.setStatus('result', JSON.stringify(result) ?? 'undefined')
    } })
  }`
  )
  process.env.PI_CODING_AGENT_DIR = agentDir
  process.env.PI_CODING_AGENT_SESSION_DIR = join(agentDir, 'sessions')
  delete process.env.PI_DESK_SAFE_MODE
  pi = await jiti.import<Pi>('@earendil-works/pi-coding-agent')
  WorkerClass = (
    await jiti.import<WorkerModule>('../src/server/l4_foundation/pi/l4-pi-chat-worker.ts')
  ).L4PiChatWorker
})

after(async () => {
  await Promise.all(workers.map((worker) => worker.dispose()))
  for (const [name, value] of [
    ['PI_CODING_AGENT_DIR', saved.agent],
    ['PI_CODING_AGENT_SESSION_DIR', saved.sessions],
    ['PI_DESK_SAFE_MODE', saved.safe]
  ]) {
    if (value === undefined) delete process.env[name!]
    else process.env[name!] = value
  }
  await rm(root, { recursive: true, force: true })
})

async function worker(name: string): Promise<Worker> {
  const cwd = join(root, name)
  await mkdir(cwd, { recursive: true })
  const manager = pi.SessionManager.inMemory(cwd)
  const result = new WorkerClass(cwd, manager)
  managers.set(result, manager)
  workers.push(result)
  await result.getRuntime()
  return result
}

async function waitQuestion(owner: Worker, count = 1): Promise<void> {
  if (owner.nativeUi.snapshot().requests.length === count) return
  await new Promise<void>((resolveWait, reject) => {
    const timer = setTimeout(() => {
      release()
      reject(new Error('等待原生问题超时'))
    }, 5000)
    const release = owner.nativeUi.subscribe(() => {
      if (owner.nativeUi.snapshot().requests.length !== count) return
      clearTimeout(timer)
      release()
      resolveWait()
    })
  })
}

test('原生上下文具有 RPC UI，确认拒绝与空字符串保持不同语义', async () => {
  const owner = await worker('values')
  assert.equal(owner.nativeUi.snapshot().statuses.mode, 'true/rpc')
  for (const [method, value, expected] of [
    ['confirm', false, 'false'],
    ['input', '', '""'],
    ['editor', '一\n二', '"一\\n二"']
  ] as const) {
    const operation = owner.executeNativeCommand('ui-check', method)
    await waitQuestion(owner)
    const request = owner.nativeUi.snapshot().requests[0]!
    owner.nativeUi.respond({ id: request.id, value })
    await operation
    assert.equal(owner.nativeUi.snapshot().statuses.result, expected)
    assert.throws(() => owner.nativeUi.respond({ id: request.id, value }), /问题已结束/)
  }
})

test('连续四步交互直接交接问题，只在流程结束后清空', async () => {
  const owner = await worker('sequence')
  const titles: Array<string | null> = []
  const release = owner.nativeUi.subscribe((event) => {
    if (event.type === 'snapshot') titles.push(event.snapshot.requests[0]?.title ?? null)
  })
  try {
    const operation = owner.executeNativeCommand('ui-check', 'sequence')
    for (const [title, value] of [
      ['1/4 · 确认', true],
      ['2/4 · 选择', '甲'],
      ['3/4 · 输入', '名称'],
      ['4/4 · 编辑', '完成内容']
    ] as const) {
      await waitQuestion(owner)
      const request = owner.nativeUi.snapshot().requests[0]!
      assert.equal(request.title, title)
      owner.nativeUi.respond({ id: request.id, value })
      assert.throws(() => owner.nativeUi.respond({ id: request.id, value }), /问题已结束/)
    }
    await operation
    assert.deepEqual(titles, ['1/4 · 确认', '2/4 · 选择', '3/4 · 输入', '4/4 · 编辑', null])
    assert.equal(owner.nativeUi.hasPending, false)
  } finally {
    release()
  }
})

test('选项和回答类型由服务端校验，失败保留待处理问题', async () => {
  const owner = await worker('validation')
  const operation = owner.executeNativeCommand('ui-check', 'select')
  await waitQuestion(owner)
  const request = owner.nativeUi.snapshot().requests[0]!
  assert.throws(() => owner.nativeUi.respond({ id: request.id, value: true }), /回答类型/)
  assert.throws(() => owner.nativeUi.respond({ id: request.id, value: '不存在' }), /选项/)
  assert.equal(owner.nativeUi.snapshot().requests.length, 1)
  owner.nativeUi.respond({ id: request.id, value: '乙' })
  await operation
  assert.equal(owner.nativeUi.snapshot().statuses.result, '"乙"')
})

test('原生超时、AbortSignal 和多个等待项均正确释放', async () => {
  const owner = await worker('cancel')
  await owner.executeNativeCommand('ui-check', 'timed')
  assert.equal(owner.nativeUi.snapshot().statuses.result, 'false')
  await owner.executeNativeCommand('ui-check', 'abort')
  assert.equal(owner.nativeUi.snapshot().statuses.result, 'undefined')
  const operation = owner.executeNativeCommand('ui-check', 'parallel')
  await waitQuestion(owner, 2)
  owner.nativeUi.cancelAll()
  await operation
  assert.equal(owner.nativeUi.snapshot().statuses.result, '[null,null]')
  assert.equal(owner.nativeUi.hasPending, false)
})

test('通知与草稿事件不写消息，状态挂件可更新和清除', async () => {
  const owner = await worker('extras')
  const entries = JSON.stringify(managers.get(owner)!.getEntries())
  const events: string[] = []
  const release = owner.nativeUi.subscribe((event) => events.push(event.type))
  await owner.executeNativeCommand('ui-check', 'extras')
  const state = owner.nativeUi.snapshot()
  assert.equal(state.statuses.status, '准备完成')
  assert.equal(state.widgets['下方']?.placement, 'belowEditor')
  assert.deepEqual(state.widgets['上方']?.lines, ['行一', '行二'])
  assert.ok(events.includes('notify') && events.includes('editor_text'))
  await owner.executeNativeCommand('ui-check', 'clear')
  assert.equal(owner.nativeUi.snapshot().statuses.status, undefined)
  assert.deepEqual(owner.nativeUi.snapshot().widgets, {})
  assert.equal(JSON.stringify(managers.get(owner)!.getEntries()), entries)
  release()
})

test('启动提问可先交付会话基线，用户等待不占用加载超时', async () => {
  const owner = await worker('startup')
  assert.equal(owner.nativeUi.snapshot().requests[0]?.title, '启动确认')
  const request = owner.nativeUi.snapshot().requests[0]!
  const operation = owner.executeNativeCommand('ui-check', 'extras')
  const guarded = owner.nativeUi.waitForOperation(
    operation,
    20,
    () => new Error('不应把用户等待计入加载时间')
  )
  const answer = setTimeout(() => owner.nativeUi.respond({ id: request.id, value: true }), 60)
  try {
    await guarded
  } finally {
    clearTimeout(answer)
  }
  assert.equal(owner.nativeUi.snapshot().statuses.status, '准备完成')
})

test('Worker 关闭取消编辑等待，旧交互 ID 不可再次回答', async () => {
  const owner = await worker('dispose')
  const operation = owner.executeNativeCommand('ui-check', 'editor').catch(() => undefined)
  await waitQuestion(owner)
  const id = owner.nativeUi.snapshot().requests[0]!.id
  await owner.dispose()
  await operation
  assert.throws(() => owner.nativeUi.respond({ id, value: '迟到回答' }), /问题已结束/)
  assert.deepEqual(owner.nativeUi.snapshot(), { requests: [], statuses: {}, widgets: {} })
})
