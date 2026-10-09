import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { UsageRuntime } from '../src/usage-runtime.js'
import { scanUsageFiles } from '../src/usage-scan.js'

for (const layout of ['project', 'flat'] as const) {
  test(`单会话用量定位只访问目标文件，不枚举无关项目或子代理（${layout}）`, async (context) => {
    const root = resolve('temp/run/usage', `session-lookup-${randomUUID()}`)
    const sessionsRoot = join(root, 'sessions')
    const cwd = process.platform === 'win32' ? 'C:\\fixture\\lookup' : '/fixture/lookup'
    const directoryName =
      process.platform === 'win32' ? '--C--fixture-lookup--' : '--fixture-lookup--'
    const directory = layout === 'flat' ? sessionsRoot : join(sessionsRoot, directoryName)
    const unrelated = join(sessionsRoot, '--unrelated--')
    const nested = join(directory, 'subagents')
    const source = { workId: 'lookup-work', sessionId: 'lookup-session', branchId: 'v1:main' }
    const path = join(directory, `2026-01-01T00-00-00-000Z_${source.sessionId}.jsonl`)
    await Promise.all([
      fs.mkdir(unrelated, { recursive: true }),
      fs.mkdir(nested, { recursive: true })
    ])
    const header = {
      type: 'session',
      version: 3,
      id: source.sessionId,
      cwd,
      timestamp: '2026-01-01T00:00:00.000Z'
    }
    await Promise.all([
      fs.writeFile(path, `${JSON.stringify(header)}\n`),
      fs.writeFile(join(directory, 'unrelated-session.jsonl'), 'not a session'),
      fs.writeFile(join(unrelated, 'old-session.jsonl'), 'not a session'),
      fs.writeFile(join(nested, 'child.jsonl'), 'not a session')
    ])
    const reads = context.mock.method(fs, 'readdir')
    const stats = context.mock.method(fs, 'stat')
    syncBuiltinESMExports()
    const scanned: string[] = []
    const runtime = new UsageRuntime({
      sessionsRoot,
      workSessions: { listWorkSessions: async () => [{ source, cwd, status: 'idle' as const }] },
      scanFiles: async (files) => {
        scanned.push(...files.map((file) => file.path))
        return scanUsageFiles(files)
      },
      logger: { info() {}, warn() {} }
    })
    context.after(async () => {
      await runtime.dispose()
      context.mock.restoreAll()
      syncBuiltinESMExports()
      await fs.rm(root, { recursive: true, force: true })
    })
    const signal = new AbortController().signal
    await runtime.sessionAnalysis({ source }, signal)
    await runtime.sessionTimeline({ source }, signal)
    assert.deepEqual(scanned, [path], '再次访问复用已定位的目标文件')
    assert.ok(reads.mock.calls.length > 0, '真实文件系统枚举应被观测')
    const allowed = new Set([
      resolve(directory),
      resolve(sessionsRoot),
      resolve(sessionsRoot, directoryName)
    ])
    assert.ok(
      reads.mock.calls.every((call) => allowed.has(resolve(String(call.arguments[0])))),
      '不得枚举无关项目或子代理目录'
    )
    assert.ok(
      stats.mock.calls.every((call) => resolve(String(call.arguments[0])) === path),
      '仅对已命中的候选文件读取属性'
    )
    await fs.writeFile(path, `${JSON.stringify({ ...header, cwd: `${cwd}-changed` })}\n`)
    await assert.rejects(
      runtime.sessionAnalysis({ source }, signal),
      /工作会话目录与 Pi Session 不一致/
    )
    await fs.writeFile(path, `${JSON.stringify({ ...header, id: 'replacement-session' })}\n`)
    await assert.rejects(runtime.sessionAnalysis({ source }, signal), /Pi Session 文件不存在/)
    await fs.rm(path)
    await assert.rejects(runtime.sessionAnalysis({ source }, signal), /Pi Session 文件不存在/)
  })
}
