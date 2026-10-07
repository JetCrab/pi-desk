import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { createJiti } from 'jiti'

type PiRuntimeModule = typeof import('../src/server/l4_foundation/pi/l4-pi-work-session-runtime')
type SessionManagerModule = typeof import('@earendil-works/pi-coding-agent')
type PiChatWorker = import('../src/server/l4_foundation/pi/l4-pi-chat-worker').L4PiChatWorker
type Deferred = { promise: Promise<void>; resolve: () => void }

const require = createRequire(import.meta.url)
const serverOnlyEntry = require.resolve('server-only')
const jiti = createJiti(import.meta.url, {
  moduleCache: false,
  tsconfigPaths: join(process.cwd(), 'tsconfig.json'),
  alias: { 'server-only': join(dirname(serverOnlyEntry), 'empty.js') }
})

test('运行中 Fork 只复制历史且不干预源 Worker，Tree 和 Clone 仍要求空闲', async (t) => {
  const runRoot = resolve('temp/run/work-session-fork', `history-isolation-${process.pid}`)
  const agentDir = join(runRoot, 'agent')
  const cwd = join(runRoot, 'project')
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR
  const originalSessionDir = process.env.PI_CODING_AGENT_SESSION_DIR
  await mkdir(cwd, { recursive: true })
  process.env.PI_CODING_AGENT_DIR = agentDir
  process.env.PI_CODING_AGENT_SESSION_DIR = join(agentDir, 'sessions')

  const runtimes: Array<ReturnType<PiRuntimeModule['L4PiWorkSessionRuntime']['create']>> = []
  try {
    const { L4PiWorkSessionRuntime, L4PiSessionBranchBlockedError } =
      await jiti.import<PiRuntimeModule>(
        '../src/server/l4_foundation/pi/l4-pi-work-session-runtime.ts'
      )
    const runtime = L4PiWorkSessionRuntime.create(cwd)
    runtimes.push(runtime)
    const manager = Reflect.get(runtime, 'sessionManager') as InstanceType<
      SessionManagerModule['SessionManager']
    >
    const firstUserId = manager.appendMessage({
      role: 'user',
      content: '起始问题',
      timestamp: 1
    })
    const assistantMessage = {
      role: 'assistant' as const,
      content: [{ type: 'text' as const, text: '历史回答' }],
      api: 'openai-completions' as const,
      provider: 'test',
      model: 'test',
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
      },
      stopReason: 'stop' as const,
      timestamp: 2
    }
    const historicalAssistantId = manager.appendMessage(assistantMessage)
    const selectedUserId = manager.appendMessage({
      role: 'user',
      content: '从这里继续编辑',
      timestamp: 3
    })
    manager.appendMessage({ ...assistantMessage, timestamp: 4 })
    const currentLeafId = manager.appendMessage({
      role: 'user',
      content: '原会话当前正在回答的问题',
      timestamp: 5
    })
    const sourceSessionId = runtime.sessionId
    const sourceBranchId = runtime.branchId
    const sourceFile = manager.getSessionFile()!
    const sourceContent = await readFile(sourceFile, 'utf8')
    const worker = Reflect.get(runtime, 'chatWorker') as PiChatWorker
    t.mock.method(worker, 'assertIdle', (): void => {
      throw new Error('主 Agent 运行时不能切换分支')
    })
    const interrupt = t.mock.method(worker, 'interrupt')
    const dispose = t.mock.method(worker, 'dispose')

    const fork = runtime.createBranchedSession({ position: 'before', entryId: selectedUserId })
    runtimes.push(fork.runtime)
    assert.equal(fork.editorText, '从这里继续编辑')
    assert.notEqual(fork.runtime.sessionId, sourceSessionId)
    const forkManager = Reflect.get(fork.runtime, 'sessionManager') as typeof manager
    const { SessionManager } = await jiti.import<SessionManagerModule>(
      '@earendil-works/pi-coding-agent'
    )
    const savedFork = SessionManager.open(forkManager.getSessionFile()!)
    assert.deepEqual(
      savedFork.getEntries().map((entry) => entry.id),
      [firstUserId, historicalAssistantId]
    )
    assert.equal(savedFork.getHeader()?.parentSession, sourceFile)

    const emptyFork = runtime.createBranchedSession({ position: 'before', entryId: firstUserId })
    runtimes.push(emptyFork.runtime)
    assert.equal(emptyFork.editorText, '起始问题')
    assert.deepEqual((await emptyFork.runtime.readSessionTree()).nodes, [])
    assert.throws(
      () => runtime.createBranchedSession({ position: 'before', entryId: historicalAssistantId }),
      { name: 'L4PiSessionForkTargetError' }
    )
    assert.throws(
      () => runtime.createBranchedSession({ position: 'before', entryId: 'missing-entry' }),
      { name: 'L4PiSessionEntryNotFoundError' }
    )
    await assert.rejects(runtime.branch(selectedUserId), L4PiSessionBranchBlockedError)
    assert.throws(
      () => runtime.createBranchedSession({ position: 'at' }),
      L4PiSessionBranchBlockedError
    )

    assert.equal(runtime.sessionId, sourceSessionId)
    assert.equal(runtime.branchId, sourceBranchId)
    assert.equal(manager.getLeafId(), currentLeafId)
    assert.equal(Reflect.get(runtime, 'chatWorker'), worker)
    assert.equal(interrupt.mock.callCount(), 0)
    assert.equal(dispose.mock.callCount(), 0)
    assert.equal(await readFile(sourceFile, 'utf8'), sourceContent)

    const continuedId = manager.appendMessage({ ...assistantMessage, timestamp: 6 })
    assert.equal(SessionManager.open(sourceFile).getEntry(continuedId)?.parentId, currentLeafId)
    assert.deepEqual(
      SessionManager.open(forkManager.getSessionFile()!)
        .getEntries()
        .map((entry) => entry.id),
      [firstUserId, historicalAssistantId]
    )
  } finally {
    t.mock.restoreAll()
    for (const runtime of runtimes) await runtime.dispose()
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir
    if (originalSessionDir === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR
    else process.env.PI_CODING_AGENT_SESSION_DIR = originalSessionDir
    await rm(runRoot, { recursive: true, force: true })
  }
})

function deferred(): Deferred {
  let resolve!: () => void
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

test('WorkSessionRuntime 导航失败保留 Worker，整体关闭收敛后释放 sessionId', async () => {
  const runId = `l4-runtime-close-${process.pid}`
  const runRoot = resolve('temp/pi/l4-basic-session-mode', runId)
  const agentDir = join(runRoot, 'agent', 'config')
  const sessionDir = join(runRoot, 'agent', 'sessions')
  const cwd = await mkdtemp(join(resolve('temp/tests'), 'l4-pi-runtime-close-'))
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR
  const originalSessionDir = process.env.PI_CODING_AGENT_SESSION_DIR
  await mkdir(agentDir, { recursive: true })
  await mkdir(sessionDir, { recursive: true })
  process.env.PI_CODING_AGENT_DIR = agentDir
  process.env.PI_CODING_AGENT_SESSION_DIR = sessionDir

  let runtime: ReturnType<PiRuntimeModule['L4PiWorkSessionRuntime']['create']> | undefined
  let closingRuntime: ReturnType<PiRuntimeModule['L4PiWorkSessionRuntime']['create']> | undefined
  let reopening: ReturnType<PiRuntimeModule['L4PiWorkSessionRuntime']['open']> | undefined
  let releaseBranchClose: (() => void) | undefined
  let releaseRegistryClose: (() => void) | undefined
  try {
    const piRuntimeModule = await jiti.import<PiRuntimeModule>(
      '../src/server/l4_foundation/pi/l4-pi-work-session-runtime.ts'
    )
    const { L4PiWorkSessionRuntime, L4PiSessionBranchBlockedError, listL4PiLoadedNativeTools } =
      piRuntimeModule
    runtime = L4PiWorkSessionRuntime.create(cwd)
    const sessionManager = Reflect.get(runtime, 'sessionManager') as InstanceType<
      SessionManagerModule['SessionManager']
    >
    sessionManager.appendMessage({
      role: 'user',
      content: [{ type: 'text', text: 'first branch node' }],
      timestamp: 1
    })
    sessionManager.appendMessage({
      role: 'user',
      content: [{ type: 'text', text: 'current leaf' }],
      timestamp: 2
    })
    const [firstEntry] = sessionManager.getEntries()
    assert.ok(firstEntry)
    const originalLeafId = sessionManager.getLeafId()
    const originalBranchId = runtime.branchId
    const branchClose = deferred()
    releaseBranchClose = branchClose.resolve
    let branchWorkerDisposeCount = 0
    const branchWorker = {
      assertIdle(): void {},
      async navigateTree(): Promise<boolean> {
        throw new L4PiSessionBranchBlockedError('fixture navigation unavailable')
      },
      dispose(): Promise<void> {
        branchWorkerDisposeCount += 1
        return branchClose.promise
      },
      async listNativeTools(): Promise<[]> {
        return []
      }
    }
    Reflect.set(runtime, 'chatWorker', branchWorker)
    const waitForClose = Reflect.get(runtime, 'waitForWorkerClose') as (
      execution: Promise<void>,
      timeoutMs: number
    ) => Promise<void>
    Reflect.set(
      runtime,
      'waitForWorkerClose',
      function (execution: Promise<void>, _timeoutMs: number) {
        return Reflect.apply(waitForClose, this, [execution, 5])
      }
    )

    await assert.rejects(runtime.branch(firstEntry.id), L4PiSessionBranchBlockedError)
    assert.equal(sessionManager.getLeafId(), originalLeafId)
    assert.equal(runtime.branchId, originalBranchId)
    assert.equal(Reflect.get(runtime, 'chatWorker'), branchWorker)
    assert.equal(branchWorkerDisposeCount, 0)
    branchClose.resolve()
    await branchClose.promise
    await runtime.dispose()

    reopening = L4PiWorkSessionRuntime.open(cwd, runtime.sessionId)
    closingRuntime = await reopening
    reopening = undefined
    const close = deferred()
    releaseRegistryClose = close.resolve
    let loadedOnlyReads = 0
    const closingWorker = {
      dispose: (): Promise<void> => close.promise,
      async listNativeTools(loadedOnly: boolean): Promise<[]> {
        if (loadedOnly) loadedOnlyReads += 1
        return []
      }
    }
    Reflect.set(closingRuntime, 'chatWorker', closingWorker)

    await closingRuntime.dispose()
    await assert.rejects(
      L4PiWorkSessionRuntime.open(cwd, closingRuntime.sessionId),
      /Pi session runtime has been disposed/
    )
    assert.deepEqual(await listL4PiLoadedNativeTools(), [])
    assert.equal(loadedOnlyReads, 0)

    close.resolve()
    await close.promise
    for (let attempt = 0; attempt < 5; attempt += 1) await new Promise<void>(setImmediate)
    const reopenedRuntime = await L4PiWorkSessionRuntime.open(cwd, closingRuntime.sessionId)
    assert.notEqual(reopenedRuntime, closingRuntime)
    await reopenedRuntime.dispose()
    runtime = undefined
  } finally {
    releaseBranchClose?.()
    releaseRegistryClose?.()
    if (reopening) await (await reopening).dispose()
    if (closingRuntime) await closingRuntime.dispose()
    if (runtime) await runtime.dispose()
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir
    if (originalSessionDir === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR
    else process.env.PI_CODING_AGENT_SESSION_DIR = originalSessionDir
    await rm(runRoot, { recursive: true, force: true })
    await rm(cwd, { recursive: true, force: true })
  }
})
