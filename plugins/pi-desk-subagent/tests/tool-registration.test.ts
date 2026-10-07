import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Agent } from '@earendil-works/pi-agent-core'
import {
  AgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type ExtensionAPI,
  type ExtensionContext,
  type ModelRuntime,
  type ToolDefinition
} from '@earendil-works/pi-coding-agent'
import { getModel } from '@earendil-works/pi-ai/compat'
import type { SubagentConfig } from '../src/agent-config'
import {
  childAllowedTools,
  excludeSubagentPackageExtensions,
  SubagentRuntime,
  type SubagentParentContext
} from '../src/subagent-runtime'

async function writeAgent(
  agentDir: string,
  name: 'explore' | 'research',
  description: string,
  tools: string
): Promise<void> {
  const dir = join(agentDir, 'agents')
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, `${name}.md`),
    `---\ndescription: ${description}\ntools: ${tools}\n---\n\n${name} prompt\n`,
    'utf8'
  )
}

test('Child Tool 白名单只在原配置上追加 ctx', () => {
  assert.deepEqual(childAllowedTools(['read', 'grep', 'ctx']), ['read', 'grep', 'ctx'])
  assert.deepEqual(childAllowedTools(['read', 'grep']), ['read', 'grep', 'ctx'])
})

test('Child 扩展结果排除 pi-desk-subagent 自身路径', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-desk-subagent-filter-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const packageRoot = join(root, 'pi-desk-subagent')
  const selfPath = join(packageRoot, 'dist', 'index.js')
  const otherPath = join(root, 'pi-desk-ctx', 'dist', 'index.js')
  await mkdir(join(packageRoot, 'dist'), { recursive: true })
  await mkdir(join(root, 'pi-desk-ctx', 'dist'), { recursive: true })
  await writeFile(selfPath, '', 'utf8')
  await writeFile(otherPath, '', 'utf8')

  const result = excludeSubagentPackageExtensions(
    {
      extensions: [{ resolvedPath: selfPath }, { resolvedPath: otherPath }],
      errors: [],
      runtime: {}
    } as never,
    packageRoot
  )
  assert.deepEqual(
    result.extensions.map((extension) => extension.resolvedPath),
    [otherPath]
  )
})

test('Child 加载 Extension 生命周期但不开放白名单外 Tool', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-desk-subagent-child-extensions-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const agentDir = join(root, 'agent')
  const cwd = join(root, 'project')
  await mkdir(join(agentDir, 'extensions'), { recursive: true })
  await mkdir(cwd, { recursive: true })
  await writeFile(
    join(agentDir, 'extensions', 'child-marker.js'),
    `export default function childMarker(pi) {
  pi.registerCommand('child-marker', { description: 'child marker', handler: async () => {} })
  pi.registerTool({
    name: 'extra_child_tool',
    label: 'Extra Child Tool',
    description: '不在 Agent allowlist 中',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    execute: async () => ({ content: [{ type: 'text', text: 'extra' }], details: {} })
  })
}\n`,
    'utf8'
  )

  const model = getModel('anthropic', 'claude-sonnet-4-5')
  assert.ok(model)
  const modelRuntime = {
    hasConfiguredAuth: () => true,
    checkAuth: async () => ({ source: 'test' }),
    isUsingOAuth: () => false,
    getModel: () => model,
    registerProvider(): void {},
    registerNativeProvider(): void {},
    unregisterProvider(): void {}
  } as unknown as ModelRuntime
  const pi = {
    registerTool(): void {},
    getActiveTools(): string[] {
      return []
    },
    setActiveTools(): void {},
    events: {
      emit(): void {},
      on(): () => void {
        return () => undefined
      }
    },
    on(): () => void {
      return () => undefined
    }
  } as unknown as ExtensionAPI
  class ExposedSubagentRuntime extends SubagentRuntime {
    create(
      config: SubagentConfig,
      parent: SubagentParentContext,
      sessionManager: SessionManager
    ): Promise<AgentSession> {
      return this.createChildSession(config, parent, sessionManager)
    }
  }
  const runtime = new ExposedSubagentRuntime(pi, modelRuntime, agentDir)
  const session = await runtime.create(
    {
      name: 'explore',
      description: 'Explore',
      tools: ['read'],
      systemPrompt: 'Explore prompt'
    },
    {
      cwd,
      sessionId: 'parent-session',
      sessionDir: join(root, 'sessions'),
      model,
      thinkingLevel: 'off',
      projectTrusted: false
    },
    SessionManager.inMemory(cwd)
  )
  context.after(() => session.dispose())

  assert.ok(session.extensionRunner.getCommand('child-marker'))
  assert.equal(
    session.getAllTools().some((tool) => tool.name === 'read'),
    true
  )
  assert.equal(
    session.getAllTools().some((tool) => tool.name === 'extra_child_tool'),
    false
  )
})

test('父工具只暴露 Agent description，不暴露 Research 内部工具', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-desk-subagent-tools-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const agentDir = join(root, 'agent')
  const cwd = join(root, 'project')
  await mkdir(cwd, { recursive: true })
  await writeAgent(agentDir, 'explore', '只用于代码探索。', 'read, grep, find, ls')
  await writeAgent(
    agentDir,
    'research',
    '只用于外部研究。',
    'research_delegate, external_research, read, grep, find, ls'
  )
  await writeFile(
    join(agentDir, 'settings.json'),
    JSON.stringify({ agents: { dev: { disabled: true } } }),
    'utf8'
  )

  const tools = new Map<string, ToolDefinition>()
  const pi = {
    registerTool(tool: ToolDefinition): void {
      tools.set(tool.name, tool)
    },
    getActiveTools(): string[] {
      return []
    },
    setActiveTools(): void {},
    events: {
      emit(): void {},
      on(): () => void {
        return () => undefined
      }
    },
    on(): () => void {
      return () => undefined
    },
    appendEntry(): string {
      return 'entry'
    },
    sendMessage(): void {}
  } as unknown as ExtensionAPI
  const runtime = new SubagentRuntime(pi, {} as ModelRuntime, agentDir)
  const ctx = {
    cwd,
    model: undefined,
    thinkingLevel: 'off',
    sessionManager: {
      getSessionId: () => 'parent-session',
      getSessionDir: () => join(root, 'sessions'),
      getSessionFile: () => join(root, 'parent.jsonl'),
      getBranch: () => []
    },
    isProjectTrusted: () => true
  } as unknown as ExtensionContext

  await runtime.startSession(ctx)

  assert.deepEqual(
    [...tools.keys()],
    ['agent', 'agent_resume', 'agent_steer', 'agent_list', 'agent_stop']
  )
  assert.equal(tools.has('external_research'), false)
  assert.equal(tools.has('research_delegate'), false)
  const agentTool = tools.get('agent')
  assert.ok(agentTool)
  const agentSchema = agentTool.parameters as {
    properties: { subagent_type: { enum: string[]; description: string } }
  }
  assert.deepEqual(agentSchema.properties.subagent_type.enum, ['explore', 'research'])
  const roleGuide = agentTool.promptGuidelines?.[0] ?? ''
  assert.match(roleGuide, /- explore: 只用于代码探索。/)
  assert.match(roleGuide, /- research: 只用于外部研究。/)
  assert.doesNotMatch(roleGuide, /- dev:/)
  assert.doesNotMatch(roleGuide, /research_delegate|Research Worker|分片/)
  assert.doesNotMatch(
    [agentTool.description, agentTool.promptSnippet, ...(agentTool.promptGuidelines ?? [])].join(
      '\n'
    ),
    /Frontmatter/
  )
})

test('真实 Pi 系统提示词包含角色职责，不注入主代理分工策略', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-desk-subagent-guidelines-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const agentDir = join(root, 'agent')
  const cwd = join(root, 'project')
  await mkdir(cwd, { recursive: true })
  await writeAgent(agentDir, 'explore', '只用于代码探索。', 'read, grep, find, ls')

  const tools = new Map<string, ToolDefinition>()
  const pi = {
    registerTool(tool: ToolDefinition): void {
      tools.set(tool.name, tool)
    },
    getActiveTools(): string[] {
      return []
    },
    setActiveTools(): void {},
    events: {
      emit(): void {},
      on(): () => void {
        return () => undefined
      }
    },
    on(): () => void {
      return () => undefined
    }
  } as unknown as ExtensionAPI
  const runtime = new SubagentRuntime(pi, {} as ModelRuntime, agentDir)
  const ctx = {
    cwd,
    model: undefined,
    thinkingLevel: 'off',
    sessionManager: {
      getSessionId: () => 'parent-session',
      getSessionDir: () => join(root, 'sessions'),
      getSessionFile: () => join(root, 'parent.jsonl'),
      getBranch: () => []
    },
    isProjectTrusted: () => true
  } as unknown as ExtensionContext
  await runtime.startSession(ctx)

  const model = getModel('anthropic', 'claude-sonnet-4-5')
  assert.ok(model)
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir: root,
    settingsManager: SettingsManager.inMemory(),
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true
  })
  await resourceLoader.reload()
  const session = new AgentSession({
    agent: new Agent({
      getApiKey: () => 'test-key',
      initialState: { model, systemPrompt: '', tools: [] },
      streamFn: () => {
        throw new Error('prompt is not part of this integration test')
      }
    }),
    sessionManager: SessionManager.inMemory(cwd),
    settingsManager: SettingsManager.inMemory(),
    cwd,
    resourceLoader,
    modelRuntime: {} as ModelRuntime,
    customTools: [...tools.values()],
    initialActiveToolNames: [...tools.keys()]
  })
  context.after(() => session.dispose())

  const prompt = session.systemPrompt
  assert.match(prompt, /- explore: 只用于代码探索。/)
  assert.match(prompt, /- dev: 执行派发的开发任务/)
  assert.doesNotMatch(
    prompt,
    /优先考虑并行|冻结任务范围|主代理不得重复|立即结束当前回合|必须包含目标、范围|不得根据类型名称猜测|一般只在需要大任务/
  )
})
