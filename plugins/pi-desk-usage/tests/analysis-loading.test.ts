import assert from 'node:assert/strict'
import { appendFile, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import type { UsageSessionAnalysisSnapshot } from '../src/protocol.js'
import { UsageRuntime } from '../src/usage-runtime.js'
import { scanUsageFiles } from '../src/usage-scan.js'

const runRoot = fileURLToPath(new URL('../../../temp/run/usage-analysis/', import.meta.url))
const startedAt = Date.UTC(2026, 7, 1)

function jsonl(entries: unknown[]): string {
  return `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`
}

function assistant(id: string, input: number, timestamp = startedAt + 1000) {
  return {
    type: 'message',
    id,
    parentId: null,
    timestamp: new Date(timestamp).toISOString(),
    message: {
      role: 'assistant',
      content: [],
      provider: 'fixture',
      model: 'model',
      usage: { input, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
      timestamp
    }
  }
}

function header(id: string, cwd: string) {
  return { type: 'session', version: 3, id, cwd, timestamp: new Date(startedAt).toISOString() }
}

test('多子代理分析批量读取，共享缓存并刷新变化或缺失的文件', async (context) => {
  const root = join(runRoot, `batch-loading-${process.pid}-${Date.now()}`)
  await mkdir(root, { recursive: true })
  context.after(() => rm(root, { recursive: true, force: true }))
  const sessionsRoot = join(root, 'sessions')
  const projectSessions = join(
    sessionsRoot,
    `--${root.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`
  )
  const sessionId = 'batch-session'
  const mainFile = join(projectSessions, `2026-08-01_${sessionId}.jsonl`)
  const childFiles = Array.from({ length: 8 }, (_, index) =>
    join(
      index % 2 === 0
        ? join(projectSessions, 'subagents', sessionId)
        : join(root, 'legacy-subagents'),
      `child-${index}.jsonl`
    )
  )
  await mkdir(join(projectSessions, 'subagents', sessionId), { recursive: true })
  await mkdir(join(root, 'legacy-subagents'), { recursive: true })
  await Promise.all(
    childFiles.map((path, index) =>
      writeFile(
        path,
        jsonl([header(`child-${index}`, root), assistant(`call-${index}`, index + 1)])
      )
    )
  )
  await writeFile(
    mainFile,
    jsonl([
      header(sessionId, root),
      assistant('main-call', 100),
      ...childFiles.map((sessionFile, index) => ({
        type: 'custom',
        id: `launch-${index}`,
        parentId: null,
        timestamp: new Date(startedAt).toISOString(),
        customType: 'pi-desk-subagent:launch:v1',
        data: {
          version: 1,
          kind: 'launch',
          taskId: `child-${index}`,
          agentType: 'research',
          title: `子代理 ${index}`,
          sessionFile,
          startedAt
        }
      }))
    ])
  )

  const source = { workId: 'batch-work', sessionId, branchId: 'batch-branch' }
  const scanBatches: string[][] = []
  const runtime = new UsageRuntime({
    sessionsRoot,
    workSessions: {
      listWorkSessions: async () => [{ source, cwd: root, status: 'idle' as const }]
    },
    scanFiles: async (files) => {
      scanBatches.push(files.map((file) => file.path))
      return scanUsageFiles(files)
    },
    logger: { info() {}, warn() {} }
  })
  context.after(() => runtime.dispose())
  const signal = new AbortController().signal
  const input = { source }
  const result = (await runtime.sessionAnalysis(
    input,
    signal
  )) as unknown as UsageSessionAnalysisSnapshot
  assert.equal(result.sources.length, 9)
  assert.deepEqual(
    result.sources.map((item) => item.totals.input),
    [100, 1, 2, 3, 4, 5, 6, 7, 8]
  )
  assert.deepEqual(
    scanBatches.map((batch) => batch.length),
    [1, 8]
  )

  await runtime.sessionAnalysis(input, signal)
  await runtime.sessionTimeline(input, signal)
  await runtime.sessionActivities(
    { ...input, startAt: startedAt, endAt: startedAt + 10_000, offset: 0, limit: 100 },
    signal
  )
  assert.equal(scanBatches.length, 2, '概览、时间线和活动应复用相同文件缓存')

  await appendFile(childFiles[0]!, jsonl([assistant('additional-call', 20, startedAt + 2000)]))
  const refreshed = (await runtime.sessionAnalysis(
    input,
    signal
  )) as unknown as UsageSessionAnalysisSnapshot
  assert.equal(refreshed.sources[1]?.totals.input, 21)
  assert.deepEqual(scanBatches.at(-1), [childFiles[0]])
  assert.equal(scanBatches.length, 3, '文件变化后只重新解析发生变化的文件')

  await rm(childFiles[1]!)
  const missing = (await runtime.sessionAnalysis(
    input,
    signal
  )) as unknown as UsageSessionAnalysisSnapshot
  assert.equal(missing.sources.length, 9)
  assert.equal(missing.sources[2]?.totals.input, 0)
  assert.equal(missing.sources[2]?.error, '子代理 Session 文件不存在或无法读取')
  assert.equal(scanBatches.length, 3, '文件删除后不能使用旧缓存结果')
})

test('冷加载 Fork 分析仍排除继承的主会话和子代理记录', async (context) => {
  const root = join(runRoot, `fork-loading-${process.pid}-${Date.now()}`)
  const sessionsRoot = join(root, 'sessions')
  const projectSessions = join(
    sessionsRoot,
    `--${root.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`
  )
  await mkdir(projectSessions, { recursive: true })
  context.after(() => rm(root, { recursive: true, force: true }))
  const parentFile = join(projectSessions, '2026-08-01_parent-session.jsonl')
  const forkFile = join(projectSessions, '2026-08-01_fork-session.jsonl')
  const inherited = [
    assistant('inherited-call', 100),
    {
      type: 'custom',
      id: 'inherited-launch',
      parentId: null,
      timestamp: new Date(startedAt).toISOString(),
      customType: 'pi-desk-subagent:launch:v1',
      data: {
        version: 1,
        kind: 'launch',
        taskId: 'inherited-child',
        agentType: 'research',
        title: '父会话子代理',
        sessionFile: join(root, 'inherited-child.jsonl'),
        startedAt
      }
    }
  ]
  await writeFile(parentFile, jsonl([header('parent-session', root), ...inherited]))
  await writeFile(
    forkFile,
    jsonl([
      { ...header('fork-session', root), parentSession: parentFile },
      ...inherited,
      assistant('fork-call', 30, startedAt + 2000)
    ])
  )
  const source = { workId: 'fork-work', sessionId: 'fork-session', branchId: 'fork-branch' }
  const scannedPaths: string[] = []
  const runtime = new UsageRuntime({
    sessionsRoot,
    workSessions: {
      listWorkSessions: async () => [{ source, cwd: root, status: 'idle' as const }]
    },
    scanFiles: async (files) => {
      scannedPaths.push(...files.map((file) => file.path))
      return scanUsageFiles(files)
    },
    logger: { info() {}, warn() {} }
  })
  context.after(() => runtime.dispose())
  const result = (await runtime.sessionAnalysis(
    { source },
    new AbortController().signal
  )) as unknown as UsageSessionAnalysisSnapshot
  assert.equal(result.inherited?.input, 100)
  assert.equal(result.sources.length, 1)
  assert.equal(result.sources[0]?.totals.input, 30)
  assert.deepEqual(new Set(scannedPaths), new Set([forkFile, parentFile]))
})
