import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import test from 'node:test'
import type { PluginJsonObject } from '@jetcrab/pi-desk-sdk/entry'
import type {
  UsageReportSnapshot,
  UsageSessionActivityPage,
  UsageSessionAnalysisSnapshot,
  UsageSessionPage,
  UsageSessionTimelineSnapshot
} from '../src/protocol.js'
import { UsageRuntime } from '../src/usage-runtime.js'
import { scanUsageFiles, type UsageFileDescriptor } from '../src/usage-scan.js'

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000

function at(day: number, hour = 12): number {
  return Date.UTC(2026, 7, day, hour) - SHANGHAI_OFFSET_MS
}

function iso(value: number): string {
  return new Date(value).toISOString()
}

function usage(input: {
  input: number
  output: number
  cacheRead?: number
  cacheWrite?: number
  cost?: number
}) {
  return {
    input: input.input,
    output: input.output,
    cacheRead: input.cacheRead ?? 0,
    cacheWrite: input.cacheWrite ?? 0,
    totalTokens: input.input + input.output + (input.cacheRead ?? 0) + (input.cacheWrite ?? 0),
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: input.cost ?? 0
    }
  }
}

function jsonl(entries: unknown[]): string {
  return `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`
}

function report(value: PluginJsonObject): UsageReportSnapshot {
  return value as unknown as UsageReportSnapshot
}

function sessionPage(value: PluginJsonObject): UsageSessionPage {
  return value as unknown as UsageSessionPage
}

function sessionAnalysis(value: PluginJsonObject): UsageSessionAnalysisSnapshot {
  return value as unknown as UsageSessionAnalysisSnapshot
}

function sessionTimeline(value: PluginJsonObject): UsageSessionTimelineSnapshot {
  return value as unknown as UsageSessionTimelineSnapshot
}

function sessionActivities(value: PluginJsonObject): UsageSessionActivityPage {
  return value as unknown as UsageSessionActivityPage
}

test('报告读取宿主共享时区，跨夏令时也不会把用量归到相邻日期', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-desk-usage-region-'))
  const sessionsRoot = join(root, 'sessions')
  const directory = join(sessionsRoot, '--project--')
  await mkdir(directory, { recursive: true })
  const timestamps = ['2024-03-10T04:30:00Z', '2024-03-10T05:30:00Z', '2024-03-11T04:30:00Z']
  await writeFile(
    join(directory, 'main.jsonl'),
    jsonl([
      {
        type: 'session',
        version: 3,
        id: 'region-fixture',
        cwd: root,
        timestamp: '2024-03-01T05:00:00Z'
      },
      ...timestamps.map((timestamp, index) => ({
        type: 'usage',
        id: `call-${index}`,
        parentId: index ? `call-${index - 1}` : null,
        timestamp,
        kind: 'cache_warm',
        provider: 'fixture',
        model: 'model',
        usage: usage({ input: (index + 1) * 10, output: 0 })
      }))
    ])
  )
  const runtime = new UsageRuntime({
    sessionsRoot,
    scanFiles: (files) => scanUsageFiles(files),
    settings: {
      getSnapshot: () => ({ region: { locale: 'en', timeZone: 'America/New_York' } }),
      subscribe: () => () => undefined
    }
  })
  context.after(async () => {
    await runtime.dispose()
    await rm(root, { recursive: true, force: true })
  })
  const result = report(
    await runtime.report(
      {
        startAt: Date.parse('2024-03-01T05:00:00Z'),
        endAt: Date.parse('2024-04-01T04:00:00Z')
      },
      new AbortController().signal
    )
  )
  const day = result.series.find((item) => item.startAt === Date.parse('2024-03-10T05:00:00Z'))
  assert.ok(day)
  assert.equal(day.endAt, Date.parse('2024-03-11T04:00:00Z'))
  assert.equal(day.totals.input, 20)
  assert.equal(result.totals.input, 60)
})

test('官方 usage 记录按实际模型计费，嵌套用量不重复加入父结果', async (context) => {
  const root = join(
    process.cwd(),
    'temp/pi/l4-usage-native',
    `usage-${process.pid}-${Date.now()}`,
    'agent'
  )
  await mkdir(root, { recursive: true })
  context.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'session.jsonl')
  await writeFile(
    path,
    jsonl([
      { type: 'session', version: 3, id: 'usage-fixture', cwd: root, timestamp: iso(at(1)) },
      {
        type: 'usage',
        id: 'warm',
        parentId: null,
        timestamp: iso(at(1)),
        kind: 'cache_warm',
        provider: 'fixture',
        model: 'cached-model',
        usage: usage({ input: 10, output: 0, cacheRead: 100, cost: 0.12 })
      },
      {
        type: 'usage',
        id: 'image',
        parentId: 'warm',
        timestamp: iso(at(1)),
        kind: 'image_generation',
        provider: 'fixture',
        model: 'image-model',
        usage: usage({ input: 20, output: 0, cost: 0.3 })
      },
      {
        type: 'message',
        id: 'parent-tool',
        parentId: 'image',
        timestamp: iso(at(1)),
        message: {
          role: 'toolResult',
          toolCallId: 'call',
          toolName: 'codemode',
          content: [],
          isError: false,
          usage: usage({ input: 40, output: 2, cost: 0.4 }),
          nestedCalls: {
            calls: [{ toolName: 'child', usage: usage({ input: 30, output: 1, cost: 0.2 }) }]
          }
        }
      }
    ])
  )
  const metadata = await stat(path)
  const [scanned] = await scanUsageFiles([
    { path, size: metadata.size, modifiedAt: metadata.mtimeMs, nestedSubagent: false }
  ])
  assert.equal(scanned.error, null)
  assert.ok(scanned.file)
  assert.deepEqual(
    scanned.file.events.map((event) => [
      event.kind,
      event.provider,
      event.model,
      event.totals.cost
    ]),
    [
      ['cache-warm', 'fixture', 'cached-model', 0.12],
      ['usage', 'fixture', 'image-model', 0.3],
      ['tool-result', null, null, 0.4]
    ]
  )
  assert.equal(scanned.file.counts.assistantMessages, 0)
  assert.equal(scanned.file.counts.toolResults, 1)
  assert.equal(
    Math.round(scanned.file.events.reduce((sum, event) => sum + event.totals.cost, 0) * 100),
    82
  )
})

test('扫描旧 Pi Super subagent JSONL 中的 Launch、Completion 和 State', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-desk-usage-legacy-subagent-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const cwd = join(root, 'project')
  const path = join(root, 'legacy-main.jsonl')
  const completedChild = join(root, 'completed-child.jsonl')
  const stoppedChild = join(root, 'stopped-child.jsonl')
  await writeFile(
    path,
    jsonl([
      {
        type: 'session',
        version: 3,
        id: 'legacy-main',
        timestamp: iso(at(1, 9)),
        cwd
      },
      {
        type: 'custom',
        id: 'legacy-completed-launch',
        parentId: null,
        timestamp: iso(at(1, 10)),
        customType: 'pi-super-subagent:launch:v1',
        data: {
          version: 1,
          kind: 'launch',
          taskId: 'legacy-completed-task',
          agentType: 'explore',
          title: '旧完成任务',
          sessionFile: completedChild,
          startedAt: at(1, 10)
        }
      },
      {
        type: 'custom_message',
        id: 'legacy-completion',
        parentId: 'legacy-completed-launch',
        timestamp: iso(at(1, 11)),
        customType: 'pi-super-subagent:completion:v1',
        content: 'done',
        display: true,
        details: {
          version: 1,
          kind: 'terminal',
          taskId: 'legacy-completed-task',
          status: 'completed',
          sessionFile: completedChild,
          endedAt: at(1, 11)
        }
      },
      {
        type: 'custom',
        id: 'legacy-stopped-launch',
        parentId: null,
        timestamp: iso(at(1, 12)),
        customType: 'pi-super-subagent:launch:v1',
        data: {
          version: 1,
          kind: 'launch',
          taskId: 'legacy-stopped-task',
          agentType: 'research-worker',
          title: '旧停止任务',
          sessionFile: stoppedChild,
          startedAt: at(1, 12)
        }
      },
      {
        type: 'custom',
        id: 'legacy-state',
        parentId: 'legacy-stopped-launch',
        timestamp: iso(at(1, 13)),
        customType: 'pi-super-subagent:state:v1',
        data: {
          version: 1,
          kind: 'terminal',
          taskId: 'legacy-stopped-task',
          status: 'stopped',
          sessionFile: stoppedChild,
          endedAt: at(1, 13)
        }
      }
    ]),
    'utf8'
  )
  const metadata = await stat(path)
  const [result] = await scanUsageFiles([
    { path, size: metadata.size, modifiedAt: metadata.mtimeMs, nestedSubagent: false }
  ])

  assert.equal(result?.error, null)
  assert.deepEqual(
    result?.file?.childSessions.map((child) => [child.taskId, child.agentType, child.sessionFile]),
    [
      ['legacy-completed-task', 'explore', completedChild],
      ['legacy-stopped-task', 'research-worker', stoppedChild]
    ]
  )
  assert.deepEqual(
    result?.file?.childTerminals.map((terminal) => [terminal.taskId, terminal.status]),
    [
      ['legacy-completed-task', 'completed'],
      ['legacy-stopped-task', 'stopped']
    ]
  )
})

test('Session 旁的 send/turn ledger sidecar 不参与扫描', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-desk-usage-sidecar-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const sessionsRoot = join(root, 'agent', 'sessions')
  const projectDirectory = join(sessionsRoot, '--project--')
  const sessionFile = join(projectDirectory, 'main.jsonl')
  await mkdir(projectDirectory, { recursive: true })
  await Promise.all([
    writeFile(
      sessionFile,
      jsonl([
        {
          type: 'session',
          version: 3,
          id: 'sidecar-main',
          timestamp: iso(at(1, 9)),
          cwd: join(root, 'project')
        },
        {
          type: 'message',
          id: 'sidecar-a1',
          parentId: null,
          timestamp: iso(at(1)),
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'main' }],
            api: 'test',
            provider: 'my',
            model: 'gpt-5.6-luna',
            usage: usage({ input: 10, output: 2 }),
            stopReason: 'stop',
            timestamp: at(1)
          }
        }
      ]),
      'utf8'
    ),
    writeFile(
      `${sessionFile}.send-ledger.jsonl`,
      `${JSON.stringify({ type: 'accept', sendId: 'send-1' })}\n`,
      'utf8'
    ),
    writeFile(
      `${sessionFile}.turn-ledger.jsonl`,
      `${JSON.stringify({ type: 'accepted', turnId: 'turn-1' })}\n`,
      'utf8'
    )
  ])

  const scannedPaths: string[] = []
  const runtime = new UsageRuntime({
    sessionsRoot,
    scanFiles: async (files: readonly UsageFileDescriptor[]) => {
      scannedPaths.push(...files.map((file) => file.path))
      return scanUsageFiles(files, 2)
    },
    logger: { info() {}, warn() {} }
  })
  context.after(() => runtime.dispose())
  const result = report(
    await runtime.report(
      {
        startAt: at(1, 0),
        endAt: at(2, 0)
      } as PluginJsonObject,
      new AbortController().signal
    )
  )

  assert.equal(result.skippedFiles, 0)
  assert.equal(result.totals.input, 10)
  assert.equal(result.bucketMs, 30 * 60 * 1000)
  assert.equal(result.series.length, 48)
  assert.equal(result.series[0]?.startAt, at(1, 0))
  assert.equal(result.series.at(-1)?.endAt, at(2, 0))
  const shifted = report(
    await runtime.report(
      {
        startAt: at(1, 0) + 30 * 60 * 1000,
        endAt: at(2, 0) + 30 * 60 * 1000
      } as PluginJsonObject,
      new AbortController().signal
    )
  )
  assert.equal(shifted.bucketMs, 60 * 60 * 1000)
  assert.deepEqual(scannedPaths, [sessionFile])
})

test('主 Session 目录下的 subagents 子目录直接归类为子代理', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-desk-usage-nested-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const sessionsRoot = join(root, 'agent', 'sessions')
  const childDirectory = join(sessionsRoot, '--project--', 'subagents', 'parent-session')
  const childFile = join(childDirectory, 'child.jsonl')
  await mkdir(childDirectory, { recursive: true })
  await writeFile(
    childFile,
    jsonl([
      {
        type: 'session',
        version: 3,
        id: 'nested-child',
        timestamp: iso(at(2, 9)),
        cwd: join(root, 'project')
      },
      {
        type: 'message',
        id: 'nested-a1',
        parentId: null,
        timestamp: iso(at(2)),
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'nested child' }],
          api: 'test',
          provider: 'my',
          model: 'gpt-5.6-terra',
          usage: usage({ input: 40, output: 8, cacheRead: 60 }),
          stopReason: 'stop',
          timestamp: at(2)
        }
      }
    ]),
    'utf8'
  )
  const runtime = new UsageRuntime({
    sessionsRoot,
    scanFiles: (files: readonly UsageFileDescriptor[]) => scanUsageFiles(files, 2),
    logger: { info() {}, warn() {} }
  })
  context.after(() => runtime.dispose())
  const result = report(
    await runtime.report(
      {
        startAt: at(1, 0),
        endAt: at(4, 0)
      } as PluginJsonObject,
      new AbortController().signal
    )
  )
  assert.equal(result.totals.input, 40)
  const sessions = sessionPage(
    await runtime.sessions(
      {
        startAt: at(1, 0),
        endAt: at(4, 0),
        offset: 0,
        limit: 10
      } as PluginJsonObject,
      new AbortController().signal
    )
  )
  assert.equal(sessions.total, 1)
  assert.equal(sessions.items[0]?.sessionId, 'parent-session')
  assert.equal(sessions.items[0]?.mainTotals.input, 0)
  assert.deepEqual(
    sessions.items[0]?.subagents.map((item) => [item.sessionId, item.totals.input]),
    [['nested-child', 40]]
  )
})

test('主会话 Custom Launch 将间接 Worker 识别为完整子代理', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-desk-usage-delegated-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const cwd = join(root, 'project')
  const sessionsRoot = join(root, 'agent', 'sessions')
  const projectSessions = join(sessionsRoot, '--project--')
  const mainSessionId = 'delegated-main'
  const mainFile = join(projectSessions, `2026-08-01T00-00-00_${mainSessionId}.jsonl`)
  const childDirectory = join(projectSessions, 'subagents', mainSessionId)
  const childFile = join(childDirectory, 'delegated-worker.jsonl')
  const source = { workId: 'work-1', sessionId: mainSessionId, branchId: 'branch-1' }
  await Promise.all([
    mkdir(projectSessions, { recursive: true }),
    mkdir(childDirectory, { recursive: true })
  ])
  await writeFile(
    mainFile,
    jsonl([
      {
        type: 'session',
        version: 3,
        id: mainSessionId,
        timestamp: iso(at(1, 9)),
        cwd
      },
      {
        type: 'custom',
        id: 'worker-launch',
        parentId: null,
        timestamp: iso(at(1, 10)),
        customType: 'pi-desk-subagent:launch:v1',
        data: {
          version: 1,
          kind: 'launch',
          taskId: 'worker-task',
          agentType: 'research-worker',
          title: '调研独立对象',
          sessionFile: childFile,
          startedAt: at(1, 10)
        }
      },
      {
        type: 'custom',
        id: 'worker-terminal',
        parentId: 'worker-launch',
        timestamp: iso(at(1, 11)),
        customType: 'pi-desk-subagent:state:v1',
        data: {
          version: 1,
          kind: 'terminal',
          taskId: 'worker-task',
          status: 'completed',
          sessionFile: childFile,
          endedAt: at(1, 11)
        }
      }
    ]),
    'utf8'
  )
  await writeFile(
    childFile,
    jsonl([
      {
        type: 'session',
        version: 3,
        id: 'worker-task',
        timestamp: iso(at(1, 10)),
        cwd,
        parentSession: mainFile
      },
      {
        type: 'message',
        id: 'worker-assistant',
        parentId: null,
        timestamp: iso(at(1, 10)),
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'worker result' }],
          api: 'test',
          provider: 'my',
          model: 'gpt-5.6-luna',
          usage: usage({ input: 40, output: 8, cacheRead: 60 }),
          stopReason: 'stop',
          timestamp: at(1, 10)
        }
      }
    ]),
    'utf8'
  )

  const runtime = new UsageRuntime({
    sessionsRoot,
    workSessions: {
      listWorkSessions: async () => [{ source, cwd, status: 'idle' as const }]
    },
    scanFiles: (files: readonly UsageFileDescriptor[]) => scanUsageFiles(files, 2),
    logger: { info() {}, warn() {} }
  })
  context.after(() => runtime.dispose())
  const signal = new AbortController().signal
  const sessions = sessionPage(
    await runtime.sessions(
      { startAt: at(1, 0), endAt: at(2, 0), offset: 0, limit: 10 } as PluginJsonObject,
      signal
    )
  )
  assert.deepEqual(
    sessions.items[0]?.subagents.map((child) => [child.taskId, child.title, child.agentType]),
    [['worker-task', '调研独立对象', 'research-worker']]
  )

  const analysis = sessionAnalysis(
    await runtime.sessionAnalysis({ source } as PluginJsonObject, signal)
  )
  assert.deepEqual(
    analysis.sources.map((item) => [
      item.kind,
      item.title,
      item.kind === 'subagent' ? item.status : null
    ]),
    [
      ['main', basename(cwd), null],
      ['subagent', '调研独立对象', 'completed']
    ]
  )
  const timeline = sessionTimeline(
    await runtime.sessionTimeline({ source } as PluginJsonObject, signal)
  )
  assert.equal(
    timeline.sources.some((item) => item.key === 'worker-task'),
    true
  )
})

test('近期报表沿父记录读取旧子代理并去重 Fork 复制 Entry', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-desk-usage-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const sessionsRoot = join(root, 'agent', 'sessions')
  const projectSessions = join(sessionsRoot, '--project--')
  const legacyChildDir = join(root, 'project', 'temp', 'pi', 'pi-desk-subagent', 'main-session')
  const childFile = join(legacyChildDir, 'child.jsonl')
  const mainFile = join(projectSessions, 'main.jsonl')
  const forkFile = join(projectSessions, 'fork.jsonl')
  await Promise.all([
    mkdir(projectSessions, { recursive: true }),
    mkdir(legacyChildDir, { recursive: true })
  ])

  const mainAssistant = {
    type: 'message',
    id: 'main-a1',
    parentId: null,
    timestamp: iso(at(1)),
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'main' }],
      api: 'test',
      provider: 'my',
      model: 'gpt-5.6-luna',
      usage: usage({ input: 100, output: 20, cacheRead: 300, cacheWrite: 10, cost: 1 }),
      stopReason: 'stop',
      timestamp: at(1)
    }
  }
  await writeFile(
    mainFile,
    jsonl([
      {
        type: 'session',
        version: 3,
        id: 'main-session',
        timestamp: iso(at(1, 9)),
        cwd: join(root, 'project')
      },
      {
        type: 'session_info',
        id: 'main-name',
        parentId: null,
        timestamp: iso(at(1, 10)),
        name: '主会话'
      },
      mainAssistant,
      {
        type: 'message',
        id: 'launch-child',
        parentId: 'main-a1',
        timestamp: iso(at(2, 9)),
        message: {
          role: 'toolResult',
          toolCallId: 'agent-call',
          toolName: 'agent',
          content: [{ type: 'text', text: 'started' }],
          details: {
            version: 1,
            kind: 'launch',
            taskId: 'child-session',
            agentType: 'research',
            title: '调研用量插件',
            sessionFile: childFile,
            startedAt: at(2, 9)
          },
          isError: false,
          timestamp: at(2, 9)
        }
      }
    ]),
    'utf8'
  )

  await writeFile(
    childFile,
    jsonl([
      {
        type: 'session',
        version: 3,
        id: 'child-session',
        timestamp: iso(at(2, 9)),
        cwd: join(root, 'project'),
        parentSession: mainFile
      },
      {
        type: 'message',
        id: 'child-a1',
        parentId: null,
        timestamp: iso(at(2)),
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'child' }],
          api: 'test',
          provider: 'my',
          model: 'gpt-5.6-terra',
          usage: usage({ input: 50, output: 10, cacheRead: 50, cost: 0.5 }),
          stopReason: 'stop',
          timestamp: at(2)
        }
      }
    ]),
    'utf8'
  )

  await writeFile(
    forkFile,
    jsonl([
      {
        type: 'session',
        version: 3,
        id: 'fork-session',
        timestamp: iso(at(3, 9)),
        cwd: join(root, 'project'),
        parentSession: mainFile
      },
      mainAssistant,
      {
        type: 'message',
        id: 'fork-a2',
        parentId: 'main-a1',
        timestamp: iso(at(3)),
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'fork new' }],
          api: 'test',
          provider: 'my',
          model: 'gpt-5.6-luna',
          usage: usage({ input: 30, output: 5, cost: 0.25 }),
          stopReason: 'stop',
          timestamp: at(3)
        }
      }
    ]),
    'utf8'
  )

  let scannedFiles = 0
  const forkSource = {
    workId: 'fork-work',
    sessionId: 'fork-session',
    branchId: 'fork-branch'
  }
  const runtime = new UsageRuntime({
    sessionsRoot,
    workSessions: {
      listWorkSessions: async () => [
        { source: forkSource, cwd: join(root, 'project'), status: 'idle' as const }
      ]
    },
    scanFiles: async (files: readonly UsageFileDescriptor[]) => {
      scannedFiles += files.length
      return scanUsageFiles(files, 2)
    },
    logger: { info() {}, warn() {} }
  })
  context.after(() => runtime.dispose())
  const signal = new AbortController().signal
  const input = {
    startAt: at(1, 0),
    endAt: at(4, 0)
  } as PluginJsonObject

  const all = report(await runtime.report(input, signal))
  assert.deepEqual(all.totals, {
    input: 180,
    output: 35,
    cacheRead: 350,
    cacheWrite: 10,
    cost: 1.75
  })
  assert.deepEqual(
    all.models.map((model) => [model.key, model.totals.input]),
    [
      ['my/gpt-5.6-luna', 130],
      ['my/gpt-5.6-terra', 50]
    ]
  )
  assert.equal(all.bucketMs, 6 * 60 * 60 * 1000)
  assert.equal(all.series.length, 12)
  assert.equal(all.series.filter((point) => point.totals.input > 0).length, 3)
  assert.equal(scannedFiles, 3)

  await runtime.report(input, signal)
  assert.equal(scannedFiles, 3, '相同覆盖范围应复用内存索引')

  const sessions = sessionPage(
    await runtime.sessions(
      {
        startAt: at(1, 0),
        endAt: at(4, 0),
        offset: 0,
        limit: 10
      } as PluginJsonObject,
      signal
    )
  )
  assert.equal(sessions.total, 2)
  assert.deepEqual(
    sessions.items.map((item) => [
      item.title,
      item.totals.input,
      item.mainTotals.input,
      item.subagents.map((child) => [child.title, child.agentType, child.totals.input])
    ]),
    [
      ['主会话', 150, 100, [['调研用量插件', 'research', 50]]],
      ['project', 30, 30, []]
    ]
  )

  const forkAnalysis = sessionAnalysis(
    await runtime.sessionAnalysis({ source: forkSource } as PluginJsonObject, signal)
  )
  assert.deepEqual(forkAnalysis.inherited, {
    input: 100,
    output: 20,
    cacheRead: 300,
    cacheWrite: 10,
    cost: 1
  })
  assert.equal(forkAnalysis.sources[0]?.totals.input, 30)
})

test('单 Session 分析按具体子代理标题分组并累计 Resume', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-desk-usage-analysis-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const cwd = join(root, 'project')
  const sessionsRoot = join(root, 'agent', 'sessions')
  const projectSessions = join(sessionsRoot, '--project--')
  const mainSessionId = 'analysis-session'
  const mainFile = join(projectSessions, `2026-08-01T00-00-00_${mainSessionId}.jsonl`)
  const childOneDirectory = join(projectSessions, 'subagents', mainSessionId)
  const childOneFile = join(childOneDirectory, '2026_child-one.jsonl')
  const childTwoDirectory = join(root, 'project', 'temp', 'pi', 'pi-desk-subagent', mainSessionId)
  const childTwoFile = join(childTwoDirectory, '2026_child-two.jsonl')
  await Promise.all([
    mkdir(projectSessions, { recursive: true }),
    mkdir(childOneDirectory, { recursive: true }),
    mkdir(childTwoDirectory, { recursive: true })
  ])

  await writeFile(
    mainFile,
    jsonl([
      {
        type: 'session',
        version: 3,
        id: mainSessionId,
        timestamp: iso(at(1, 8)),
        cwd
      },
      {
        type: 'session_info',
        id: 'analysis-name',
        parentId: null,
        timestamp: iso(at(1, 9)),
        name: '会话分析测试'
      },
      {
        type: 'message',
        id: 'analysis-main',
        parentId: 'analysis-name',
        timestamp: iso(at(1, 10)),
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'main' }],
          api: 'test',
          provider: 'my',
          model: 'router-auto',
          responseModel: 'gpt-5.6-luna',
          usage: usage({ input: 100, output: 20, cacheRead: 200, cost: 1 }),
          stopReason: 'stop',
          timestamp: at(1, 10)
        }
      },
      {
        type: 'message',
        id: 'launch-one',
        parentId: 'analysis-main',
        timestamp: iso(at(2, 9)),
        message: {
          role: 'toolResult',
          toolCallId: 'agent-one',
          toolName: 'agent',
          content: [{ type: 'text', text: 'started' }],
          details: {
            version: 1,
            kind: 'launch',
            taskId: 'child-one',
            agentType: 'research',
            title: '调研缓存策略',
            sessionFile: childOneFile,
            startedAt: at(2, 9)
          },
          isError: false,
          timestamp: at(2, 9)
        }
      },
      {
        type: 'message',
        id: 'resume-one',
        parentId: 'launch-one',
        timestamp: iso(at(3, 9)),
        message: {
          role: 'toolResult',
          toolCallId: 'resume-one-call',
          toolName: 'agent_resume',
          content: [{ type: 'text', text: 'resumed' }],
          details: {
            version: 1,
            kind: 'launch',
            taskId: 'child-one',
            agentType: 'research',
            title: '调研缓存策略',
            sessionFile: childOneFile,
            startedAt: at(3, 9)
          },
          isError: false,
          timestamp: at(3, 9)
        }
      },
      {
        type: 'custom_message',
        id: 'terminal-one',
        parentId: 'resume-one',
        timestamp: iso(at(3, 18)),
        customType: 'pi-desk-subagent:completion:v1',
        content: '完成',
        display: true,
        details: {
          version: 1,
          kind: 'terminal',
          taskId: 'child-one',
          status: 'completed',
          endedAt: at(3, 18),
          sessionFile: childOneFile
        }
      },
      {
        type: 'message',
        id: 'launch-two',
        parentId: 'terminal-one',
        timestamp: iso(at(4, 9)),
        message: {
          role: 'toolResult',
          toolCallId: 'agent-two',
          toolName: 'agent',
          content: [{ type: 'text', text: 'started' }],
          details: {
            version: 1,
            kind: 'launch',
            taskId: 'child-two',
            agentType: 'research',
            title: '审查统计口径',
            sessionFile: childTwoFile,
            startedAt: at(4, 9)
          },
          isError: false,
          timestamp: at(4, 9)
        }
      }
    ]),
    'utf8'
  )

  await writeFile(
    childOneFile,
    jsonl([
      { type: 'session', version: 3, id: 'child-one', timestamp: iso(at(2, 9)), cwd },
      {
        type: 'message',
        id: 'child-one-a',
        parentId: null,
        timestamp: iso(at(2, 12)),
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'one' }],
          api: 'test',
          provider: 'my',
          model: 'gpt-5.6-luna',
          usage: usage({ input: 60, output: 8, cacheRead: 90, cost: 0.4 }),
          stopReason: 'stop',
          timestamp: at(2, 12)
        }
      },
      {
        type: 'message',
        id: 'child-one-b',
        parentId: 'child-one-a',
        timestamp: iso(at(3, 12)),
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'two' }],
          api: 'test',
          provider: 'my',
          model: 'gpt-5.6-terra',
          usage: usage({ input: 40, output: 6, cacheRead: 30, cost: 0.3 }),
          stopReason: 'stop',
          timestamp: at(3, 12)
        }
      }
    ]),
    'utf8'
  )
  await writeFile(
    childTwoFile,
    jsonl([
      { type: 'session', version: 3, id: 'child-two', timestamp: iso(at(4, 9)), cwd },
      {
        type: 'message',
        id: 'child-two-a',
        parentId: null,
        timestamp: iso(at(4, 12)),
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'three' }],
          api: 'test',
          provider: 'my',
          model: 'gpt-5.6-luna',
          usage: usage({ input: 30, output: 5, cacheRead: 20, cost: 0.2 }),
          stopReason: 'stop',
          timestamp: at(4, 12)
        }
      }
    ]),
    'utf8'
  )

  const source = {
    workId: 'analysis-work',
    sessionId: mainSessionId,
    branchId: 'analysis-branch'
  }
  const runtime = new UsageRuntime({
    sessionsRoot,
    workSessions: {
      listWorkSessions: async () => [{ source, cwd, status: 'idle' as const }]
    },
    scanFiles: (files: readonly UsageFileDescriptor[]) => scanUsageFiles(files, 2),
    logger: { info() {}, warn() {} }
  })
  context.after(() => runtime.dispose())

  const result = sessionAnalysis(
    await runtime.sessionAnalysis({ source } as PluginJsonObject, new AbortController().signal)
  )
  assert.equal(result.session.title, '会话分析测试')
  assert.equal(result.inherited, null)
  assert.deepEqual(
    result.sources.map((item) => [
      item.title,
      item.kind,
      item.kind === 'subagent' ? item.agentType : null,
      item.kind === 'subagent' ? item.runCount : null,
      item.totals.input
    ]),
    [
      ['会话分析测试', 'main', null, null, 100],
      ['调研缓存策略', 'subagent', 'research', 2, 100],
      ['审查统计口径', 'subagent', 'research', 1, 30]
    ]
  )
  const childOne = result.sources[1]
  assert.ok(childOne?.kind === 'subagent')
  assert.equal(childOne.status, 'completed')
  assert.deepEqual(
    childOne.models.map((model) => [model.key, model.calls]),
    [
      ['my/gpt-5.6-luna', 1],
      ['my/gpt-5.6-terra', 1]
    ]
  )
  assert.deepEqual(
    result.recentCalls.map((call) => call.sourceKey),
    ['child-two', 'child-one', 'child-one', 'main']
  )
  const routedCall = result.recentCalls.find((call) => call.sourceKey === 'main')
  assert.equal(routedCall?.modelKey, 'my/gpt-5.6-luna')
  assert.equal(routedCall?.requestedModel, 'my/router-auto')
  assert.equal(routedCall?.actualModel, 'my/gpt-5.6-luna')

  await assert.rejects(
    runtime.sessionAnalysis(
      { source: { ...source, branchId: 'stale-branch' } } as PluginJsonObject,
      new AbortController().signal
    ),
    /工作会话来源已变化/
  )
})

test('单 Session 时间轴共享主子代理调用序列并回溯忽略与压缩', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-desk-usage-timeline-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const cwd = join(root, 'project')
  const sessionsRoot = join(root, 'agent', 'sessions')
  const projectSessions = join(sessionsRoot, '--project--')
  const sessionId = 'timeline-session'
  const mainFile = join(projectSessions, `2026-08-01T00-00-00_${sessionId}.jsonl`)
  const childDirectory = join(projectSessions, 'subagents', sessionId)
  const childFile = join(childDirectory, 'timeline-child.jsonl')
  const start = at(1, 9)
  await Promise.all([
    mkdir(projectSessions, { recursive: true }),
    mkdir(childDirectory, { recursive: true })
  ])

  await writeFile(
    mainFile,
    jsonl([
      { type: 'session', version: 3, id: sessionId, timestamp: iso(start), cwd },
      {
        type: 'custom',
        id: 'ignore-initial',
        parentId: null,
        timestamp: iso(start + 1),
        customType: 'context-ignore-state',
        data: { enabled: false, mode: 'user-turns', keepTurns: 3, updatedAt: start + 1 }
      },
      {
        type: 'message',
        id: 'main-before',
        parentId: 'ignore-initial',
        timestamp: iso(start + 10),
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'before' }],
          api: 'test',
          provider: 'my',
          model: 'gpt-5.6-luna',
          usage: usage({ input: 20, output: 5, cacheRead: 80 }),
          stopReason: 'stop',
          timestamp: start + 10
        }
      },
      {
        type: 'message',
        id: 'launch-child',
        parentId: 'main-before',
        timestamp: iso(start + 20),
        message: {
          role: 'toolResult',
          toolCallId: 'launch-call',
          toolName: 'agent',
          content: [{ type: 'text', text: 'started' }],
          details: {
            version: 1,
            kind: 'launch',
            taskId: 'timeline-child-task',
            agentType: 'dev',
            title: '持续运行的子代理',
            sessionFile: childFile,
            startedAt: start + 20
          },
          isError: false,
          timestamp: start + 20
        }
      },
      {
        type: 'custom',
        id: 'ignore-meaningful',
        parentId: 'launch-child',
        timestamp: iso(start + 30),
        customType: 'context-ignore-state',
        data: {
          enabled: true,
          mode: 'user-turns',
          cutoffTimestamp: start - 1_000,
          pendingUsageRefreshAfterTimestamp: start + 10,
          estimatedContextTokens: 60,
          keepTurns: 3,
          updatedAt: start + 30
        }
      },
      {
        type: 'custom',
        id: 'ignore-cleared',
        parentId: 'ignore-meaningful',
        timestamp: iso(start + 40),
        customType: 'context-ignore-state',
        data: {
          enabled: true,
          mode: 'user-turns',
          cutoffTimestamp: start - 1_000,
          keepTurns: 3,
          updatedAt: start + 40
        }
      },
      {
        type: 'compaction',
        id: 'main-compaction',
        parentId: 'ignore-cleared',
        timestamp: iso(start + 50),
        summary: 'summary',
        firstKeptEntryId: 'main-before',
        tokensBefore: 100
      },
      {
        type: 'message',
        id: 'main-after',
        parentId: 'main-compaction',
        timestamp: iso(start + 70),
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'after' }],
          api: 'test',
          provider: 'my',
          model: 'gpt-5.6-luna',
          usage: usage({ input: 5, output: 3, cacheRead: 20 }),
          stopReason: 'stop',
          timestamp: start + 70
        }
      },
      {
        type: 'message',
        id: 'bash-start',
        parentId: 'main-after',
        timestamp: iso(start + 75),
        message: {
          role: 'assistant',
          content: [
            {
              type: 'toolCall',
              id: 'long-bash',
              name: 'bash',
              arguments: { reasoning: '运行完整验证' }
            }
          ],
          timestamp: start + 75
        }
      },
      {
        type: 'message',
        id: 'bash-result',
        parentId: 'bash-start',
        timestamp: iso(start + 20 * 60_000),
        message: {
          role: 'toolResult',
          toolCallId: 'long-bash',
          toolName: 'bash',
          content: [{ type: 'text', text: 'completed' }],
          isError: false,
          timestamp: start + 20 * 60_000
        }
      }
    ]),
    'utf8'
  )
  await writeFile(
    childFile,
    jsonl([
      {
        type: 'session',
        version: 3,
        id: 'timeline-child',
        timestamp: iso(start + 20),
        cwd,
        parentSession: mainFile
      },
      {
        type: 'message',
        id: 'child-one',
        parentId: null,
        timestamp: iso(start + 35),
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'child one' }],
          api: 'test',
          provider: 'my',
          model: 'gpt-5.6-luna',
          usage: usage({ input: 10, output: 2, cacheRead: 30 }),
          stopReason: 'stop',
          timestamp: start + 35
        }
      },
      {
        type: 'message',
        id: 'child-two',
        parentId: 'child-one',
        timestamp: iso(start + 60),
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'child two' }],
          api: 'test',
          provider: 'my',
          model: 'gpt-5.6-luna',
          usage: usage({ input: 20, output: 4, cacheRead: 60 }),
          stopReason: 'stop',
          timestamp: start + 60
        }
      }
    ]),
    'utf8'
  )

  const source = { workId: 'timeline-work', sessionId, branchId: 'timeline-branch' }
  const runtime = new UsageRuntime({
    sessionsRoot,
    workSessions: {
      listWorkSessions: async () => [{ source, cwd, status: 'idle' as const }]
    },
    scanFiles: (files: readonly UsageFileDescriptor[]) => scanUsageFiles(files, 2),
    logger: { info() {}, warn() {} }
  })
  context.after(() => runtime.dispose())

  const result = sessionTimeline(
    await runtime.sessionTimeline({ source } as PluginJsonObject, new AbortController().signal)
  )
  assert.equal(result.totalCalls, 4)
  assert.equal(result.sampled, false)
  assert.deepEqual(
    result.sources.map((item) => [item.key, item.calls]),
    [
      ['main', 2],
      ['timeline-child-task', 2]
    ]
  )
  assert.deepEqual(
    result.markers.map((marker) => marker.kind),
    ['context-ignore', 'compaction']
  )
  assert.equal(result.markers[0]?.projectedPrompt, 60)
  assert.equal(result.markers[1]?.tokensBefore, 100)
  assert.equal(result.markers[1]?.afterPrompt, 25)

  const main = result.sources[0]!
  const child = result.sources[1]!
  const compactionAt = result.markers[1]!.timestamp
  assert.ok(main.segments[0]?.some((point) => point.at === compactionAt && point.prompt === 25))
  assert.deepEqual(
    child.segments[0]?.map((point) => point.prompt),
    [40, 80]
  )
  assert.ok(child.segments[0]![0]!.at > result.markers[0]!.timestamp)
  assert.ok(child.segments[0]![1]!.at > compactionAt)
  assert.equal(
    result.buckets.some((bucket) => bucket.calls === 0),
    true
  )
  assert.deepEqual(
    result.activities.map((activity) => [activity.kind, activity.label, activity.detail]),
    [
      ['subagent-run', '子代理运行', '持续运行的子代理'],
      ['tool', 'bash', '运行完整验证']
    ]
  )
  const activityPage = sessionActivities(
    await runtime.sessionActivities(
      {
        source,
        startAt: start,
        endAt: start + 21 * 60_000,
        offset: 0,
        limit: 20
      } as PluginJsonObject,
      new AbortController().signal
    )
  )
  assert.ok(
    activityPage.items.some(
      (activity) =>
        activity.kind === 'tool' &&
        activity.label === 'bash' &&
        activity.detail === '运行完整验证' &&
        activity.endAt === start + 20 * 60_000
    )
  )
})
