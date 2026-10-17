import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { COMMAND_RESULT_SCHEMA, type Exec } from '../src/core.js'
import workspaceExtension from '../src/index.js'
import { WorkspaceRuntime } from '../src/runtime.js'

const config = `schema: pi.workspace/v3
definitions:
  demo:
    description: Demo workspace
    provision:
      description: Prepare workspace
      handler: .pi/workspace/provision.mjs
    commands:
      test:
        description: Test workspace
        from: [occupied]
        onSuccess: occupied
        handler: .pi/workspace/commands/test.mjs
`

test('包 manifest 的 Skills 路径各自对应唯一且可读的构建资源', async () => {
  const packageRoot = resolve(process.cwd())
  const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')) as {
    pi?: { skills?: string[] }
  }
  const skillPaths = manifest.pi?.skills ?? []

  assert.deepEqual(skillPaths, [
    './dist/skills/workspace-config-authoring',
    './dist/skills/workspace-usage'
  ])
  assert.equal(new Set(skillPaths).size, skillPaths.length)
  for (const skillPath of skillPaths) {
    const directory = join(packageRoot, skillPath)
    assert.equal(existsSync(directory), true, `${skillPath} must exist in build output`)
    assert.match(await readFile(join(directory, 'SKILL.md'), 'utf8'), /^(---|#)/)
  }
})

type ExtensionHandler = (event: unknown, context: ExtensionContext) => unknown

type AgentHarness = {
  pi: ExtensionAPI
  handlers: Map<string, ExtensionHandler>
  registrationCounts: Map<string, number>
  tools: unknown[]
}

function createAgentHarness(): AgentHarness {
  const handlers = new Map<string, ExtensionHandler>()
  const registrationCounts = new Map<string, number>()
  const tools: unknown[] = []
  const pi = {
    async exec() {
      return { stdout: '', stderr: '', code: 0 }
    },
    registerTool(definition: unknown): void {
      tools.push(definition)
    },
    appendEntry(): void {},
    on(name: string, handler: ExtensionHandler): void {
      handlers.set(name, handler)
      registrationCounts.set(name, (registrationCounts.get(name) ?? 0) + 1)
    },
    events: {
      emit(): void {},
      on(): () => void {
        return () => undefined
      }
    }
  } as unknown as ExtensionAPI
  return { pi, handlers, registrationCounts, tools }
}

test('Agent 侧仅在受信任有效配置下暴露 Workspace 能力', async () => {
  const root = resolve(process.cwd(), '../../temp/pi/workspace/test-agent-registration')
  await rm(root, { recursive: true, force: true })
  try {
    const cases = [
      { name: 'missing', trusted: true, content: undefined },
      { name: 'invalid', trusted: true, content: 'schema: invalid\ndefinitions: {}\n' },
      { name: 'untrusted', trusted: false, content: config }
    ]

    for (const item of cases) {
      const project = join(root, item.name)
      if (item.content !== undefined) {
        await mkdir(join(project, '.pi'), { recursive: true })
        await writeFile(join(project, '.pi', 'workspace.yml'), item.content)
      }

      const harness = createAgentHarness()
      workspaceExtension(harness.pi)
      const context = {
        cwd: project,
        isProjectTrusted: () => item.trusted
      } as unknown as ExtensionContext
      const resourcesDiscover = harness.handlers.get('resources_discover')
      assert.ok(resourcesDiscover)
      assert.equal(harness.handlers.has('before_agent_start'), false)
      assert.equal(harness.tools.length, 0)

      const result = await resourcesDiscover(
        { type: 'resources_discover', cwd: project, reason: 'startup' },
        context
      )
      assert.equal(result, undefined)
      assert.equal(harness.handlers.has('before_agent_start'), false)
      assert.equal(harness.registrationCounts.get('before_agent_start') ?? 0, 0)
      assert.equal(harness.tools.length, 0)

      await harness.handlers.get('session_shutdown')?.({}, context)
    }

    const project = join(root, 'valid')
    await mkdir(join(project, '.pi'), { recursive: true })
    await writeFile(join(project, '.pi', 'workspace.yml'), config)

    const harness = createAgentHarness()
    workspaceExtension(harness.pi)
    const context = {
      cwd: project,
      isProjectTrusted: () => true
    } as unknown as ExtensionContext
    const resourcesDiscover = harness.handlers.get('resources_discover')
    assert.ok(resourcesDiscover)
    assert.equal(harness.tools.length, 0)
    assert.equal(harness.handlers.has('before_agent_start'), false)

    const first = await resourcesDiscover(
      { type: 'resources_discover', cwd: project, reason: 'startup' },
      context
    )
    assert.equal(first, undefined)
    assert.equal(harness.tools.length, 1)
    assert.equal((harness.tools[0] as { name?: string }).name, 'workspace')
    assert.equal(harness.registrationCounts.get('before_agent_start'), 1)
    assert.equal(harness.handlers.has('before_agent_start'), true)

    const second = await resourcesDiscover(
      { type: 'resources_discover', cwd: project, reason: 'reload' },
      context
    )
    assert.equal(second, undefined)
    assert.equal(harness.tools.length, 1)
    assert.equal(harness.registrationCounts.get('before_agent_start'), 1)

    await harness.handlers.get('session_shutdown')?.({}, context)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('新会话上下文只说明 acquire，active 后才注入精确目录和 commands', async () => {
  const root = resolve(process.cwd(), '../../temp/pi/workspace/test-extension-context')
  await rm(root, { recursive: true, force: true })
  try {
    await mkdir(join(root, '.pi', 'workspace', 'commands'), { recursive: true })
    await writeFile(join(root, '.pi', 'workspace.yml'), config)
    await writeFile(
      join(root, '.pi', 'workspace', 'provision.mjs'),
      'export default async () => ({ success: true })\n'
    )
    await writeFile(
      join(root, '.pi', 'workspace', 'commands', 'test.mjs'),
      'export default async () => ({ success: true })\n'
    )

    const exec: Exec = async (_program, args) => {
      const input = JSON.parse(await readFile(args[2]!, 'utf8')) as {
        workspace: { root: string }
      }
      await mkdir(input.workspace.root, { recursive: true })
      await writeFile(
        args[3]!,
        JSON.stringify({
          schema: COMMAND_RESULT_SCHEMA,
          success: true,
          summary: 'prepared'
        })
      )
      return { stdout: '', stderr: '', code: 0 }
    }
    const runtime = new WorkspaceRuntime({
      exec,
      runnerPath: join(root, 'runner.mjs'),
      poolRoot: join(root, 'pool'),
      persist: () => undefined,
      changed: () => undefined
    })
    const context = { cwd: root, trusted: true, sessionId: 'session-extension' }

    const initial = await runtime.promptContext(context)
    assert.match(initial ?? '', /workspace acquire/)
    assert.doesNotMatch(initial ?? '', /可用工作区数量|自动复用/)

    await runtime.acquire(context, { definition: 'demo', requirement: '上下文需求' })
    const active = await runtime.promptContext(context)
    assert.match(active ?? '', /上下文需求/)
    assert.match(active ?? '', /test（Test workspace）/)
    assert.match(active ?? '', /工作区目录：/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
