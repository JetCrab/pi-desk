import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import test from 'node:test'
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { COMMAND_RESULT_SCHEMA, type WorkspaceCommandInput } from '../src/core.js'
import workspaceExtension from '../src/index.js'

interface CapturedTool {
  name: string
  execute(
    toolCallId: string,
    input: Record<string, unknown>,
    signal: AbortSignal,
    onUpdate: undefined,
    context: ExtensionContext
  ): Promise<{ content: Array<{ type: string; text: string }>; details: Record<string, unknown> }>
}

const testRoot = resolve(process.cwd(), '../../temp/pi/workspace/tool-tests')

test('workspace acquire 和 run 不向 AI 返回完整池 Snapshot', async () => {
  const project = join(testRoot, `project-${Date.now()}`)
  const poolRoot = join(testRoot, 'home')
  await mkdir(join(project, '.pi', 'workspace', 'commands'), { recursive: true })
  await writeFile(
    join(project, '.pi', 'workspace.yml'),
    `schema: pi.workspace/v3
definitions:
  demo:
    description: Demo workspace
    provision:
      description: Prepare workspace
      handler: .pi/workspace/provision.mjs
    commands:
      verify:
        description: Verify workspace
        from: [occupied]
        onSuccess: occupied
        handler: .pi/workspace/commands/verify.mjs
`,
    'utf8'
  )
  await writeFile(
    join(project, '.pi', 'workspace', 'provision.mjs'),
    'export default async () => ({ success: true })\n',
    'utf8'
  )
  await writeFile(
    join(project, '.pi', 'workspace', 'commands', 'verify.mjs'),
    'export default async () => ({ success: true })\n',
    'utf8'
  )

  const tools: CapturedTool[] = []
  let sessionStart: ((event: unknown, context: ExtensionContext) => unknown) | undefined
  let resourcesDiscover: ((event: unknown, context: ExtensionContext) => unknown) | undefined
  let sessionShutdown: ((event: unknown, context: ExtensionContext) => unknown) | undefined
  const eventHandlers = new Map<string, (value: unknown) => unknown>()
  const registeredMethods: string[] = []
  const previewRegistrations: unknown[] = []
  const entries: Array<{ type: string; data: unknown }> = []
  const originalHome = process.env.HOME
  const originalProfile = process.env.USERPROFILE
  let context: ExtensionContext | undefined
  process.env.HOME = poolRoot
  process.env.USERPROFILE = poolRoot
  try {
    const pi = {
      async exec(_program: string, args: string[]) {
        const input = JSON.parse(await readFile(args[2]!, 'utf8')) as WorkspaceCommandInput
        if (input.command === 'provision') await mkdir(input.workspace.root, { recursive: true })
        await writeFile(
          args[3]!,
          JSON.stringify({
            schema: COMMAND_RESULT_SCHEMA,
            success: true,
            summary: `${input.command} completed`
          }),
          'utf8'
        )
        return { stdout: '', stderr: '', code: 0 }
      },
      registerTool(definition: CapturedTool): void {
        tools.push(definition)
      },
      appendEntry(type: string, data: unknown): void {
        entries.push({ type, data })
      },
      on(name: string, handler: (event: unknown, context: ExtensionContext) => unknown): void {
        if (name === 'session_start') sessionStart = handler
        if (name === 'resources_discover') resourcesDiscover = handler
        if (name === 'session_shutdown') sessionShutdown = handler
      },
      events: {
        emit(channel: string, value: unknown): void {
          if (channel === 'pi-desk:session-preview-directory') previewRegistrations.push(value)
          const event = value as {
            type?: string
            registration?: { pluginName?: string; method?: string }
          }
          if (
            event.type === 'register' &&
            event.registration?.pluginName === 'workspace' &&
            event.registration.method
          ) {
            registeredMethods.push(event.registration.method)
          }
        },
        on(channel: string, handler: (value: unknown) => unknown): () => void {
          eventHandlers.set(channel, handler)
          return () => eventHandlers.delete(channel)
        }
      }
    } as unknown as ExtensionAPI
    workspaceExtension(pi)
    assert.equal(tools.length, 0)
    assert.deepEqual(registeredMethods, ['snapshot', 'use', 'run'])

    const signal = new AbortController().signal
    context = {
      cwd: project,
      hasUI: false,
      signal,
      isProjectTrusted: () => true,
      sessionManager: {
        getBranch: () => [],
        getSessionId: () => 'session-tool'
      }
    } as unknown as ExtensionContext
    assert.ok(sessionStart)
    await sessionStart({}, context)
    assert.deepEqual(previewRegistrations, [{ directory: project, default: true }])
    assert.ok(resourcesDiscover)
    const resources = await resourcesDiscover(
      { type: 'resources_discover', cwd: project, reason: 'startup' },
      context
    )
    assert.equal(resources, undefined)
    assert.equal(tools.length, 1)
    const tool = tools[0]
    assert.ok(tool)
    const acquired = await tool.execute(
      'acquire-1',
      { action: 'acquire', definition: 'demo', requirement: '最小结果测试' },
      signal,
      undefined,
      context
    )
    assert.equal('snapshot' in acquired.details, false)
    assert.equal('workspaces' in acquired.details, false)
    assert.equal(typeof acquired.details.root, 'string')
    assert.equal('entry' in acquired.details, false)
    assert.deepEqual(previewRegistrations.at(-1), {
      directory: acquired.details.root,
      default: true
    })

    const repository = join(String(acquired.details.root), 'server')
    await mkdir(repository, { recursive: true })
    const externalOperation = eventHandlers.get('pi-workspace:operation/v1')
    assert.ok(externalOperation)
    await externalOperation({
      directory: repository,
      command: 'external-check',
      startedAt: 100,
      endedAt: 200,
      result: 'success',
      summary: '外部检查完成',
      logPath: join(project, 'temp', 'pi', 'external-check', 'check.log')
    })
    const listed = await tool.execute('list-1', { action: 'list' }, signal, undefined, context)
    const workspaces = listed.details.workspaces as Array<{
      occupation: { operations: Array<{ command: string; summary?: string }> }
    }>
    assert.equal(workspaces[0]?.occupation.operations.at(-1)?.command, 'external-check')
    assert.equal(workspaces[0]?.occupation.operations.at(-1)?.summary, '外部检查完成')

    const run = await tool.execute(
      'run-1',
      { action: 'run', command: 'verify' },
      signal,
      undefined,
      context
    )
    assert.equal('snapshot' in run.details, false)
    assert.equal('workspaces' in run.details, false)
    assert.equal(run.details.command, 'verify')
    assert.equal(previewRegistrations.length, 2)
    assert.equal(entries.length, 1)
    assert.equal(entries[0]?.type, 'workspace-selection-v2')
  } finally {
    if (sessionShutdown && context) await sessionShutdown({}, context)
    process.env.HOME = originalHome
    process.env.USERPROFILE = originalProfile
    await rm(testRoot, { recursive: true, force: true })
  }
})
