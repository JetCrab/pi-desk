import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { existsSync, renameSync } from 'node:fs'
import { mkdir, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import {
  COMMAND_RESULT_SCHEMA,
  MARKER_FILE,
  appendRunningOperation,
  formatWorkspaceRef,
  occupiedMarker,
  readMarker,
  workspaceBaseRoot,
  writeMarker,
  type Exec,
  type WorkspaceCommandInput,
  type WorkspaceSelection
} from '../src/core.js'
import {
  WorkspaceRuntime,
  type WorkspaceRuntimeDependencies,
  type WorkspaceTaskInput
} from '../src/runtime.js'
import type { WorkspaceChangedEvent } from '../src/contract.js'

const tempRoot = resolve(process.cwd(), '../../temp/pi/workspace/test-runtime-v3')
afterEach(async () => rm(tempRoot, { recursive: true, force: true }))

const configSource = `schema: pi.workspace/v3
definitions:
  demo:
    description: Demo workspace
    provision:
      description: Prepare workspace
      parameters:
        type: object
        additionalProperties: false
        properties:
          runtime:
            type: string
            required: false
            default: node-22
      handler: .pi/workspace/provision.mjs
    commands:
      commit:
        description: Commit workspace
        from: [occupied]
        onSuccess: occupied
        handler: .pi/workspace/commands/commit.mjs
      reset:
        description: Reset workspace
        from: [occupied]
        onSuccess: available
        handler: .pi/workspace/commands/reset.mjs
      remove:
        description: Remove workspace
        from: [available, occupied]
        onSuccess: removed
        handler: .pi/workspace/commands/remove.mjs
`

async function createProject(): Promise<string> {
  const project = join(tempRoot, 'project')
  await mkdir(join(project, '.pi', 'workspace', 'commands'), { recursive: true })
  await writeFile(join(project, '.pi', 'workspace.yml'), configSource, 'utf8')
  await writeFile(
    join(project, '.pi', 'workspace', 'provision.mjs'),
    'export default async () => ({ success: true })\n'
  )
  for (const command of ['commit', 'reset', 'remove']) {
    await writeFile(
      join(project, '.pi', 'workspace', 'commands', `${command}.mjs`),
      'export default async () => ({ success: true })\n',
      'utf8'
    )
  }
  return project
}

type FakeMode = 'success' | 'failure' | 'missing-output'

function fakeExecutor(options?: {
  modes?: Record<string, FakeMode>
  calls?: WorkspaceCommandInput[]
}): Exec {
  const modes = options?.modes ?? {}
  const calls = options?.calls ?? []
  return async (_program, args) => {
    const inputPath = args[2]!
    const outputPath = args[3]!
    const input = JSON.parse(await readFile(inputPath, 'utf8')) as WorkspaceCommandInput
    calls.push(input)

    const mode = modes[input.command] ?? 'success'
    if (input.command === 'remove') {
      await rm(input.workspace.root, { recursive: true, force: true })
    }

    if (mode === 'missing-output') return { stdout: '', stderr: '', code: 0 }
    if (mode === 'failure') {
      await writeFile(
        outputPath,
        JSON.stringify({
          schema: COMMAND_RESULT_SCHEMA,
          success: false,
          error: `${input.command} failed`
        }),
        'utf8'
      )
      return { stdout: '', stderr: '', code: 1 }
    }

    await writeFile(
      outputPath,
      JSON.stringify({
        schema: COMMAND_RESULT_SCHEMA,
        success: true,
        summary: `${input.command} completed`
      }),
      'utf8'
    )
    return { stdout: '', stderr: '', code: 0 }
  }
}

function runtimeOptions(
  project: string,
  exec: Exec,
  hooks: Partial<Pick<WorkspaceRuntimeDependencies, 'changed' | 'startTask'>> = {}
) {
  const selections: Array<WorkspaceSelection | null> = []
  const previewDirectories: string[] = []
  const changes: WorkspaceChangedEvent[] = []
  const runtime = new WorkspaceRuntime({
    exec,
    runnerPath: join(project, 'runner.mjs'),
    poolRoot: join(tempRoot, 'pool'),
    persist: (selection) => selections.push(selection),
    changed: (event) => {
      changes.push(event)
      hooks.changed?.(event)
    },
    previewDirectoryChanged: (directory) => previewDirectories.push(directory),
    ...(hooks.startTask ? { startTask: hooks.startTask } : {})
  })
  return { runtime, selections, changes, previewDirectories }
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((complete) => {
    resolve = complete
  })
  return { promise, resolve }
}

test(
  '后台命令受理即返回，查询和其他工作区不被阻塞，同一工作区拒绝重复提交',
  { timeout: 5_000 },
  async () => {
    const project = await createProject()
    const gate = deferred<void>()
    const completed = deferred<void>()
    const execute = fakeExecutor()
    const tasks: WorkspaceTaskInput[] = []
    const { runtime } = runtimeOptions(
      project,
      async (program, args, options) => {
        const input = JSON.parse(await readFile(args[2]!, 'utf8')) as WorkspaceCommandInput
        if (input.command === 'commit') await gate.promise
        return execute(program, args, options)
      },
      {
        changed(event) {
          if (event.summary === 'commit completed') completed.resolve()
        },
        startTask(input) {
          tasks.push(input)
          return { complete() {}, fail() {}, stopped() {} }
        }
      }
    )
    const context = { cwd: project, trusted: true, sessionId: 'session-background' }
    try {
      const first = await runtime.acquire(context, { definition: 'demo', requirement: '后台执行' })
      const second = await runtime.acquire(context, {
        definition: 'demo',
        requirement: '其他工作区'
      })
      const accepted = await runtime.startRun(context, {
        workspace: first.workspaceRef,
        command: 'commit'
      })
      const running = accepted.snapshot.workspaces.find((item) => item.id === accepted.workspaceId)
      assert.equal(running?.occupation?.operations.at(-1)?.result, null)
      assert.equal(tasks.at(-1)?.detailSource?.path, accepted.logPath)
      assert.equal(tasks.at(-1)?.taskType, 'commit')
      await assert.rejects(
        runtime.startRun(context, { workspace: first.workspaceRef, command: 'reset' }),
        /该工作区已有命令正在执行/
      )
      const snapshot = await runtime.use(context, second.workspaceRef)
      assert.equal(snapshot.active, second.workspaceRef)
      const other = await runtime.run(context, { workspace: second.workspaceRef, command: 'reset' })
      assert.equal(
        other.snapshot.workspaces.find((item) => item.root === second.root)?.status,
        'available'
      )
      assert.equal(
        other.snapshot.workspaces
          .find((item) => item.root === first.root)
          ?.occupation?.operations.at(-1)?.result,
        null
      )
      gate.resolve()
      await completed.promise
      const finished = await runtime.snapshot(context)
      assert.equal(
        finished.workspaces.find((item) => item.root === first.root)?.occupation?.operations.at(-1)
          ?.result,
        'success'
      )
    } finally {
      gate.resolve()
      runtime.shutdown()
    }
  }
)

test(
  '任务登记前不清理历史日志，受理后维护保留占用日志和100个未保护目录',
  { timeout: 10_000 },
  async () => {
    const project = await createProject()
    const root = join(project, 'temp', 'pi', 'workspace')
    const completed = deferred<void>()
    let observedBeforeCleanup = false
    const { runtime } = runtimeOptions(project, fakeExecutor(), {
      startTask(input) {
        if (input.taskType === 'commit') observedBeforeCleanup = existsSync(join(root, 'old-0'))
        return { complete() {}, fail() {}, stopped() {} }
      },
      changed(event) {
        if (event.summary === 'commit completed') completed.resolve()
      }
    })
    const context = { cwd: project, trusted: true, sessionId: 'maintenance' }
    try {
      const acquired = await runtime.acquire(context, {
        definition: 'demo',
        requirement: '历史日志保护'
      })
      const protectedPath = acquired.snapshot.workspaces[0]!.occupation!.operations[0]!.logPath
      for (let index = 0; index < 103; index += 1) {
        const path = join(root, `old-${index}`)
        await mkdir(path)
        await utimes(path, new Date(1000 + index), new Date(1000 + index))
      }
      const accepted = await runtime.startRun(context, { command: 'commit' })
      assert.equal(observedBeforeCleanup, true)
      assert.equal(accepted.snapshot.workspaces[0]?.occupation?.operations.at(-1)?.result, null)
      await completed.promise
      assert.equal(existsSync(protectedPath), true)
      assert.equal(existsSync(accepted.logPath), true)
      assert.equal((await readdir(root)).length, 102)
      assert.equal(existsSync(join(root, 'old-0')), false)
    } finally {
      runtime.shutdown()
    }
  }
)

test('日志维护失败记录诊断，不覆盖成功命令结果', { timeout: 5_000 }, async (testContext) => {
  const project = await createProject()
  const root = join(project, 'temp', 'pi', 'workspace')
  const backup = `${root}-held`
  const completed = deferred<void>()
  const execute = fakeExecutor()
  const warnings = testContext.mock.method(console, 'warn', () => undefined)
  let held = false
  const { runtime } = runtimeOptions(
    project,
    async (program, args, options) => {
      if (held) {
        renameSync(backup, root)
        held = false
      }
      return execute(program, args, options)
    },
    {
      startTask(input) {
        if (input.taskType === 'commit') {
          renameSync(root, backup)
          held = true
        }
        return { complete() {}, fail() {}, stopped() {} }
      },
      changed(event) {
        if (event.summary === 'commit completed') completed.resolve()
      }
    }
  )
  const context = { cwd: project, trusted: true, sessionId: 'maintenance-error' }
  try {
    await runtime.acquire(context, { definition: 'demo', requirement: '维护异常' })
    await runtime.startRun(context, { command: 'commit' })
    await completed.promise
    assert.equal(
      warnings.mock.calls.some((call) => call.arguments[0] === '[workspace] 历史命令日志维护失败'),
      true
    )
    assert.equal(
      (await runtime.snapshot(context)).workspaces[0]?.occupation?.operations.at(-1)?.result,
      'success'
    )
  } finally {
    runtime.shutdown()
  }
})

test('受理后立即停止，日志维护收敛后不启动命令进程', { timeout: 5_000 }, async () => {
  const project = await createProject()
  const calls: WorkspaceCommandInput[] = []
  const stopped = deferred<void>()
  const failed = deferred<void>()
  let interrupt: (() => Promise<void>) | undefined
  const { runtime } = runtimeOptions(project, fakeExecutor({ calls }), {
    startTask(input) {
      if (input.taskType === 'reset') interrupt = input.interrupt
      return {
        complete() {},
        fail() {},
        stopped() {
          stopped.resolve()
        }
      }
    },
    changed(event) {
      if (event.level === 'error') failed.resolve()
    }
  })
  const context = { cwd: project, trusted: true, sessionId: 'maintenance-stop' }
  try {
    await runtime.acquire(context, { definition: 'demo', requirement: '受理时停止' })
    await runtime.startRun(context, { command: 'reset' })
    assert.ok(interrupt)
    await interrupt()
    await stopped.promise
    await failed.promise
    assert.deepEqual(
      calls.map((item) => item.command),
      ['provision']
    )
    assert.equal((await runtime.snapshot(context)).workspaces[0]?.status, 'occupied')
  } finally {
    runtime.shutdown()
  }
})

test('后台命令失败后保留占用、失败记录及日志，并推送错误通知', { timeout: 5_000 }, async () => {
  const project = await createProject()
  const gate = deferred<void>()
  const failed = deferred<void>()
  const execute = fakeExecutor({ modes: { reset: 'failure' } })
  const taskFailures: string[] = []
  const { runtime, changes } = runtimeOptions(
    project,
    async (program, args, options) => {
      const input = JSON.parse(await readFile(args[2]!, 'utf8')) as WorkspaceCommandInput
      if (input.command === 'reset') await gate.promise
      return execute(program, args, options)
    },
    {
      changed(event) {
        if (event.level === 'error') failed.resolve()
      },
      startTask() {
        return {
          complete() {},
          fail(message) {
            taskFailures.push(message ?? '')
          },
          stopped() {}
        }
      }
    }
  )
  const context = { cwd: project, trusted: true, sessionId: 'session-background-failure' }
  try {
    const acquired = await runtime.acquire(context, { definition: 'demo', requirement: '失败记录' })
    const accepted = await runtime.startRun(context, {
      workspace: acquired.workspaceRef,
      command: 'reset'
    })
    gate.resolve()
    await failed.promise
    const snapshot = await runtime.snapshot(context)
    assert.equal(snapshot.workspaces[0]?.status, 'occupied')
    assert.equal(snapshot.workspaces[0]?.occupation?.operations.at(-1)?.result, 'failed')
    assert.equal(snapshot.workspaces[0]?.occupation?.operations.at(-1)?.logPath, accepted.logPath)
    assert.deepEqual(taskFailures, ['reset failed'])
    assert.equal(changes.at(-1)?.level, 'error')
    assert.match(changes.at(-1)?.summary ?? '', /reset failed/)
    await assert.rejects(runtime.startRun(context, { command: 'missing' }), /不存在 command/)
  } finally {
    gate.resolve()
    runtime.shutdown()
  }
})

test('会话关闭时取消尚未完成受理的后台命令，不启动额外进程', async () => {
  const project = await createProject()
  const calls: WorkspaceCommandInput[] = []
  const { runtime } = runtimeOptions(project, fakeExecutor({ calls }))
  const context = { cwd: project, trusted: true, sessionId: 'session-background-shutdown' }
  const acquired = await runtime.acquire(context, { definition: 'demo', requirement: '启动时关闭' })
  const starting = runtime.startRun(context, { workspace: acquired.workspaceRef, command: 'reset' })
  runtime.shutdown()
  await assert.rejects(starting, { name: 'AbortError' })
  assert.deepEqual(
    calls.map((input) => input.command),
    ['provision']
  )
})

test('后台命令受理后仍能通过任务中心中止，未完成前不释放工作区', { timeout: 5_000 }, async () => {
  const project = await createProject()
  const executing = deferred<void>()
  const stopped = deferred<void>()
  const failed = deferred<void>()
  const execute = fakeExecutor()
  let interrupt: (() => Promise<void>) | undefined
  const { runtime } = runtimeOptions(
    project,
    async (program, args, options) => {
      const input = JSON.parse(await readFile(args[2]!, 'utf8')) as WorkspaceCommandInput
      if (input.command !== 'reset') return execute(program, args, options)
      executing.resolve()
      await new Promise<never>((_resolve, reject) => {
        const abort = (): void => reject(new Error('工作区命令已中断'))
        if (options.signal?.aborted) abort()
        else options.signal?.addEventListener('abort', abort, { once: true })
      })
      throw new Error('不可到达')
    },
    {
      changed(event) {
        if (event.level === 'error') failed.resolve()
      },
      startTask(input) {
        if (input.taskType === 'reset') interrupt = input.interrupt
        return {
          complete() {},
          fail() {},
          stopped() {
            stopped.resolve()
          }
        }
      }
    }
  )
  const context = { cwd: project, trusted: true, sessionId: 'session-background-stop' }
  try {
    const acquired = await runtime.acquire(context, { definition: 'demo', requirement: '后台中止' })
    await runtime.startRun(context, { workspace: acquired.workspaceRef, command: 'reset' })
    await executing.promise
    assert.ok(interrupt)
    await interrupt()
    await stopped.promise
    await failed.promise
    const snapshot = await runtime.snapshot(context)
    assert.equal(snapshot.workspaces[0]?.status, 'occupied')
    assert.equal(snapshot.workspaces[0]?.occupation?.operations.at(-1)?.result, 'failed')
    assert.match(snapshot.workspaces[0]?.occupation?.operations.at(-1)?.summary ?? '', /已中断/)
  } finally {
    runtime.shutdown()
  }
})

test('工作区选择与恢复登记默认预览目录，普通查询不重复登记', async () => {
  const project = await createProject()
  const { runtime, selections, previewDirectories } = runtimeOptions(project, fakeExecutor())
  const context = { cwd: project, trusted: true, sessionId: 'session-preview' }
  await runtime.restore(context, [])
  assert.deepEqual(previewDirectories, [project])

  const acquired = await runtime.acquire(context, { definition: 'demo', requirement: '预览目录' })
  assert.deepEqual(previewDirectories, [project, acquired.root])
  await runtime.snapshot(context)
  await runtime.promptContext(context)
  assert.equal(previewDirectories.length, 2)

  const selection = selections.at(-1)
  assert.ok(selection)
  const entries = [{ type: 'custom', customType: 'workspace-selection-v2', data: selection }]
  await runtime.restore(context, entries)
  assert.deepEqual(previewDirectories, [project, acquired.root, acquired.root])
  assert.deepEqual(selections, [selection])

  await runtime.use(context, null)
  assert.equal(previewDirectories.at(-1), project)
  await runtime.use(context, acquired.workspaceRef)
  assert.equal(previewDirectories.at(-1), acquired.root)
  await runtime.run(context, { command: 'reset' })
  assert.equal(previewDirectories.at(-1), project)
  await runtime.restore(context, entries)
  assert.equal(runtime.activeRef, null)
  assert.equal(previewDirectories.at(-1), project)
  runtime.shutdown()
})

test('工作区获取失败不登记尚未完成初始化的目录', async () => {
  const project = await createProject()
  const { runtime, previewDirectories } = runtimeOptions(
    project,
    fakeExecutor({ modes: { provision: 'failure' } })
  )
  const context = { cwd: project, trusted: true, sessionId: 'session-preview-failure' }
  await runtime.restore(context, [])
  await assert.rejects(
    runtime.acquire(context, { definition: 'demo', requirement: '失败预览' }),
    /provision failed/
  )
  assert.deepEqual(previewDirectories, [project])
  runtime.shutdown()
})

test('acquire 需求名按 Unicode 码点限制并拒绝空白与换行', async () => {
  const project = await createProject()
  const { runtime } = runtimeOptions(project, fakeExecutor())
  const context = { cwd: project, trusted: true, sessionId: 'session-runtime' }
  const exactLimit = `${'短'.repeat(18)}😀B`

  const acquired = await runtime.acquire(context, {
    definition: 'demo',
    requirement: `  ${exactLimit}  `
  })
  assert.equal(acquired.requirement, exactLimit)

  await assert.rejects(
    () =>
      runtime.acquire(context, {
        definition: 'demo',
        requirement: `${exactLimit}C`
      }),
    /不能超过 20 个字符/
  )
  await assert.rejects(
    () => runtime.acquire(context, { definition: 'demo', requirement: '   ' }),
    /必须是非空字符串/
  )
  await assert.rejects(
    () => runtime.acquire(context, { definition: 'demo', requirement: '单行\n需求' }),
    /必须是单行需求名/
  )
})

test('acquire 首次 provision，reset 后再次 acquire 自动复用同一物理目录', async () => {
  const project = await createProject()
  const calls: WorkspaceCommandInput[] = []
  const { runtime } = runtimeOptions(project, fakeExecutor({ calls }))
  const context = { cwd: project, trusted: true, sessionId: 'session-runtime' }

  const first = await runtime.acquire(context, {
    definition: 'demo',
    requirement: '需求 A'
  })
  assert.match(first.workspaceRef, /^ws-[a-f0-9]{12}@as-[a-f0-9]{16}$/)
  assert.equal(calls.filter((input) => input.command === 'provision').length, 1)
  assert.equal(first.snapshot.workspaces[0]?.status, 'occupied')
  assert.equal(first.snapshot.workspaces[0]?.occupation?.requirement, '需求 A')
  assert.equal(first.snapshot.workspaces[0]?.occupation?.sourceSessionId, 'session-runtime')

  const reset = await runtime.run(context, {
    workspace: first.workspaceRef,
    command: 'reset'
  })
  assert.equal(reset.snapshot.workspaces[0]?.status, 'available')
  assert.equal(reset.snapshot.workspaces[0]?.occupation, null)
  assert.equal(reset.snapshot.active, null)

  const second = await runtime.acquire(context, {
    definition: 'demo',
    requirement: '需求 B'
  })
  assert.equal(second.workspaceRef.split('@')[0], first.workspaceRef.split('@')[0])
  assert.notEqual(second.workspaceRef, first.workspaceRef)
  assert.equal(calls.filter((input) => input.command === 'provision').length, 1)
  assert.equal(second.snapshot.workspaces[0]?.occupation?.requirement, '需求 B')
  assert.equal(second.snapshot.workspaces[0]?.occupation?.sourceSessionId, 'session-runtime')

  await assert.rejects(() => runtime.use(context, first.workspaceRef), /assignment 已失效/)
})

test('acquire 只复用 provision 参数完全匹配的可用工作区', async () => {
  const project = await createProject()
  const calls: WorkspaceCommandInput[] = []
  const { runtime } = runtimeOptions(project, fakeExecutor({ calls }))
  const context = { cwd: project, trusted: true, sessionId: 'session-runtime' }

  const first = await runtime.acquire(context, {
    definition: 'demo',
    requirement: '参数 node-20',
    parameters: { runtime: 'node-20' }
  })
  await runtime.run(context, { workspace: first.workspaceRef, command: 'reset' })

  const second = await runtime.acquire(context, {
    definition: 'demo',
    requirement: '默认参数'
  })
  assert.notEqual(second.workspaceRef.split('@')[0], first.workspaceRef.split('@')[0])
  assert.equal(calls.filter((input) => input.command === 'provision').length, 2)
})

test('旧 marker 的长需求可恢复并原文传给 Handler', async () => {
  const project = await createProject()
  const calls: WorkspaceCommandInput[] = []
  const { runtime } = runtimeOptions(project, fakeExecutor({ calls }))
  const context = { cwd: project, trusted: true, sessionId: 'session-runtime' }
  const acquired = await runtime.acquire(context, {
    definition: 'demo',
    requirement: '旧需求'
  })
  const workspaceId = acquired.workspaceRef.split('@')[0]!
  const assignmentId = acquired.workspaceRef.split('@')[1]!
  const root = join(workspaceBaseRoot(project, join(tempRoot, 'pool')), workspaceId)
  const marker = await readMarker(root, {
    baseRoot: workspaceBaseRoot(project, join(tempRoot, 'pool'))
  })
  assert.ok(marker?.status === 'occupied')
  if (!marker || marker.status !== 'occupied') throw new Error('缺少 occupied marker')

  const legacyRequirement = `旧版需求：${'完整描述'.repeat(60)}`
  await writeFile(
    join(root, MARKER_FILE),
    `${JSON.stringify(
      {
        ...marker,
        schema: 'pi.workspace-instance/v3',
        occupation: { ...marker.occupation, requirement: legacyRequirement }
      },
      null,
      2
    )}\n`,
    'utf8'
  )

  const { runtime: restoredRuntime } = runtimeOptions(project, fakeExecutor({ calls }))
  await restoredRuntime.restore(context, [
    {
      type: 'custom',
      customType: 'workspace-selection-v2',
      data: { workspaceId, assignmentId }
    }
  ])
  const restored = await restoredRuntime.snapshot(context)
  assert.equal(restored.workspaces[0]?.occupation?.requirement, legacyRequirement)
  assert.equal(restoredRuntime.activeTitle, '旧版需求：完整描述完整描述完整描述完整…')

  await restoredRuntime.run(context, {
    workspace: acquired.workspaceRef,
    command: 'commit'
  })
  assert.equal(calls.at(-1)?.occupation.requirement, legacyRequirement)
})

test('occupied 命令成功记录 Operation 并保持占用', async () => {
  const project = await createProject()
  const { runtime, changes } = runtimeOptions(project, fakeExecutor())
  const context = { cwd: project, trusted: true, sessionId: 'session-runtime' }
  const acquired = await runtime.acquire(context, {
    definition: 'demo',
    requirement: '提交需求'
  })

  const result = await runtime.run(context, {
    workspace: acquired.workspaceRef,
    command: 'commit'
  })
  const workspace = result.snapshot.workspaces[0]!
  assert.equal(workspace.occupation?.operations.at(-1)?.result, 'success')
  assert.deepEqual(changes.at(-1), {
    workspaceId: workspace.id,
    summary: 'commit completed'
  })
  assert.equal(workspace.status, 'occupied')
  assert.equal(workspace.occupation?.operations.length, 2)
  assert.deepEqual(
    workspace.occupation?.operations.map((operation) => [operation.command, operation.result]),
    [
      ['provision', 'success'],
      ['commit', 'success']
    ]
  )
})

test('外部操作按目录写入所属 occupied 工作区', async () => {
  const project = await createProject()
  const { runtime } = runtimeOptions(project, fakeExecutor())
  const context = { cwd: project, trusted: true, sessionId: 'session-runtime' }
  const acquired = await runtime.acquire(context, {
    definition: 'demo',
    requirement: '外部操作需求'
  })
  const repository = join(acquired.root, 'server')
  await mkdir(repository, { recursive: true })

  assert.equal(
    await runtime.recordExternalOperation(context, {
      directory: repository,
      command: 'external-check',
      startedAt: 100,
      endedAt: 200,
      result: 'success',
      summary: '外部检查完成',
      logPath: join(project, 'temp', 'pi', 'external-check', 'check.log')
    }),
    true
  )
  assert.equal(
    await runtime.recordExternalOperation(context, {
      directory: project,
      command: 'external-check',
      startedAt: 300,
      endedAt: 400,
      result: 'success',
      summary: '项目根检查',
      logPath: join(project, 'temp', 'pi', 'external-check', 'outside.log')
    }),
    false
  )

  const snapshot = await runtime.snapshot(context)
  assert.deepEqual(snapshot.workspaces[0]?.occupation?.operations.at(-1), {
    command: 'external-check',
    startedAt: 100,
    endedAt: 200,
    result: 'success',
    summary: '外部检查完成',
    logPath: join(project, 'temp', 'pi', 'external-check', 'check.log')
  })
})

test('新 Runtime 恢复时将遗留运行中 Operation 标记为未知', async () => {
  const project = await createProject()
  const { runtime } = runtimeOptions(project, fakeExecutor())
  const context = { cwd: project, trusted: true, sessionId: 'session-runtime' }
  const acquired = await runtime.acquire(context, {
    definition: 'demo',
    requirement: '中断恢复需求'
  })
  const baseRoot = workspaceBaseRoot(project, join(tempRoot, 'pool'))
  const workspaceId = acquired.workspaceRef.split('@')[0]!
  const root = join(baseRoot, workspaceId)
  const marker = await readMarker(root, { baseRoot })
  assert.equal(marker?.status, 'occupied')
  if (!marker || marker.status !== 'occupied') throw new Error('缺少 occupied marker')
  const occupation = appendRunningOperation(marker.occupation, {
    command: 'verify',
    startedAt: 100,
    logPath: join(project, 'temp', 'pi', 'workspace', 'verify.log')
  })
  await writeMarker(root, occupiedMarker(marker, occupation), { baseRoot })

  const { runtime: restoredRuntime } = runtimeOptions(project, fakeExecutor())
  await restoredRuntime.restore(context, [])
  const snapshot = await restoredRuntime.snapshot(context)
  assert.equal(snapshot.workspaces[0]?.occupation?.operations.at(-1)?.result, 'unknown')
})

test('命令失败保持 occupied 并记录失败，不应用 onSuccess', async () => {
  const project = await createProject()
  const modes: Record<string, FakeMode> = { reset: 'failure' }
  const { runtime } = runtimeOptions(project, fakeExecutor({ modes }))
  const context = { cwd: project, trusted: true, sessionId: 'session-runtime' }
  const acquired = await runtime.acquire(context, {
    definition: 'demo',
    requirement: '失败需求'
  })

  await assert.rejects(
    () => runtime.run(context, { workspace: acquired.workspaceRef, command: 'reset' }),
    /reset failed/
  )
  const snapshot = await runtime.snapshot(context)
  const workspace = snapshot.workspaces[0]!
  assert.equal(workspace.status, 'occupied')
  assert.equal(workspace.occupation?.operations.at(-1)?.result, 'failed')
  assert.equal(snapshot.active, acquired.workspaceRef)
})

test('退出码成功但缺少明确结果时仍视为失败', async () => {
  const project = await createProject()
  const modes: Record<string, FakeMode> = { commit: 'missing-output' }
  const { runtime } = runtimeOptions(project, fakeExecutor({ modes }))
  const context = { cwd: project, trusted: true, sessionId: 'session-runtime' }
  const acquired = await runtime.acquire(context, {
    definition: 'demo',
    requirement: '结果协议测试'
  })

  await assert.rejects(
    () => runtime.run(context, { workspace: acquired.workspaceRef, command: 'commit' }),
    /命令结果无法解析/
  )
  const snapshot = await runtime.snapshot(context)
  assert.equal(snapshot.workspaces[0]?.status, 'occupied')
  assert.equal(snapshot.workspaces[0]?.occupation?.operations.at(-1)?.result, 'failed')
})

test('available 命令执行前先占用，remove 成功后物理记录消失', async () => {
  const project = await createProject()
  const { runtime } = runtimeOptions(project, fakeExecutor())
  const context = { cwd: project, trusted: true, sessionId: 'session-runtime' }
  const acquired = await runtime.acquire(context, {
    definition: 'demo',
    requirement: '待删除需求'
  })
  const id = acquired.workspaceRef.split('@')[0]!
  await runtime.run(context, { workspace: acquired.workspaceRef, command: 'reset' })

  const removed = await runtime.run(context, { workspace: id, command: 'remove' })
  assert.equal(removed.snapshot.workspaces.length, 0)
})

test('Marker 中的 assignment 与 active 精确一致', async () => {
  const project = await createProject()
  const { runtime, selections } = runtimeOptions(project, fakeExecutor())
  const context = { cwd: project, trusted: true, sessionId: 'session-runtime' }
  const acquired = await runtime.acquire(context, {
    definition: 'demo',
    requirement: '状态检查'
  })
  const selection = selections.at(-1)!
  assert.ok(selection)

  const baseRoot = workspaceBaseRoot(project, join(tempRoot, 'pool'))
  const id = acquired.workspaceRef.split('@')[0]!
  const marker = await readMarker(join(baseRoot, id), { baseRoot })
  assert.equal(marker?.status, 'occupied')
  assert.equal(acquired.workspaceRef, formatWorkspaceRef(id, marker?.occupation?.id ?? ''))
})
