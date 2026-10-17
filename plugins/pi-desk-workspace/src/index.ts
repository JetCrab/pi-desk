import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { StringEnum } from '@earendil-works/pi-ai'
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import {
  bindSessionPlugin,
  PluginMethodError,
  type PluginJsonObject
} from '@jetcrab/pi-desk-sdk/session'
import { Type, type Static } from 'typebox'
import {
  SELECTION_ENTRY,
  WorkspaceError,
  isJsonValue,
  loadConfigForSession,
  type WorkspaceSelection
} from './core.js'
import {
  WorkspaceRuntime,
  type WorkspaceRunInput,
  type WorkspaceRuntimeContext
} from './runtime.js'
import type { JsonValue, WorkspaceSnapshot } from './contract.js'
import {
  WORKSPACE_OPERATION_EVENT,
  parseWorkspaceExternalOperation
} from './workspace-operation-event.js'

const baseDir = dirname(fileURLToPath(import.meta.url))
const COMMAND_RUNNER = join(baseDir, 'command-runner.mjs')

const toolInputSchema = Type.Object(
  {
    action: StringEnum(['list', 'info', 'acquire', 'use', 'run'] as const),
    workspace: Type.Optional(Type.String()),
    definition: Type.Optional(Type.String()),
    requirement: Type.Optional(Type.String()),
    command: Type.Optional(Type.String()),
    parameters: Type.Optional(Type.Object({}, { additionalProperties: true }))
  },
  { additionalProperties: false }
)

type ToolInput = Static<typeof toolInputSchema>

function runtimeContext(context: ExtensionContext): WorkspaceRuntimeContext {
  return {
    cwd: context.cwd,
    trusted: context.isProjectTrusted(),
    sessionId: context.sessionManager.getSessionId()
  }
}

function jsonObject(value: unknown): PluginJsonObject {
  return JSON.parse(JSON.stringify(value)) as PluginJsonObject
}

function serialize(value: unknown): string {
  return JSON.stringify(value, null, 2)
}

function unknownFields(input: PluginJsonObject, allowed: readonly string[]): void {
  for (const key of Object.keys(input)) {
    if (!allowed.includes(key)) throw new PluginMethodError(400, `未知输入字段：${key}`)
  }
}

function requiredString(input: PluginJsonObject, field: string): string {
  const value = input[field]
  if (typeof value !== 'string' || !value.trim()) {
    throw new PluginMethodError(400, `${field} 必须是非空字符串`)
  }
  return value
}

function optionalString(input: PluginJsonObject, field: string): string | undefined {
  const value = input[field]
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !value.trim()) {
    throw new PluginMethodError(400, `${field} 必须是非空字符串`)
  }
  return value
}

function optionalParameters(
  value: unknown,
  field = 'parameters'
): Record<string, JsonValue> | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value) || !isJsonValue(value)) {
    throw new PluginMethodError(400, `${field} 必须是 JSON 对象`)
  }
  return value as Record<string, JsonValue>
}

function runInput(input: PluginJsonObject): WorkspaceRunInput {
  unknownFields(input, ['workspace', 'command', 'parameters'])
  const parameters = optionalParameters(input.parameters)
  const workspace = optionalString(input, 'workspace')
  return {
    command: requiredString(input, 'command'),
    ...(workspace ? { workspace } : {}),
    ...(parameters ? { parameters } : {})
  }
}

function methodError(error: unknown): never {
  if (error instanceof PluginMethodError) throw error
  if (error instanceof WorkspaceError) throw new PluginMethodError(409, error.message)
  throw error
}

function workspaceFromSnapshot(
  snapshot: WorkspaceSnapshot,
  workspace: string | undefined
): WorkspaceSnapshot['workspaces'][number] {
  const locator = workspace ?? snapshot.active
  if (!locator) throw new WorkspaceError('未选择工作区')
  const id = locator.includes('@') ? locator.slice(0, locator.indexOf('@')) : locator
  const record = snapshot.workspaces.find((item) => item.id === id)
  if (!record) throw new WorkspaceError(`工作区不存在：${id}`)
  return record
}

export default function workspaceExtension(pi: ExtensionAPI): void {
  const sessionPlugin = bindSessionPlugin(pi, 'workspace')
  let currentContext: ExtensionContext | undefined
  let agentIntegrationRegistered = false
  const runtime = new WorkspaceRuntime({
    exec: pi.exec.bind(pi),
    runnerPath: COMMAND_RUNNER,
    persist(selection: WorkspaceSelection | null): void {
      pi.appendEntry(SELECTION_ENTRY, selection ?? { workspaceId: null, assignmentId: null })
    },
    changed(event): void {
      sessionPlugin.push('changed', jsonObject(event))
    },
    previewDirectoryChanged(directory): void {
      sessionPlugin.addPreviewDirectory?.(directory, { default: true })
    },
    startTask(input) {
      return sessionPlugin.startTask(input)
    }
  })

  function updateStatus(context: ExtensionContext): void {
    if (!context.hasUI) return
    context.ui.setStatus(
      'workspace',
      runtime.activeRef ? `隔离工作区：${runtime.activeRef}` : undefined
    )
  }

  async function restore(context: ExtensionContext): Promise<void> {
    currentContext = context
    await runtime.restore(runtimeContext(context), context.sessionManager.getBranch())
    updateStatus(context)
  }

  sessionPlugin.registerMethod('snapshot', async (input, context) => {
    try {
      unknownFields(input, [])
      const snapshot = await runtime.snapshot(runtimeContext(context.extensionContext))
      updateStatus(context.extensionContext)
      return jsonObject(snapshot)
    } catch (error) {
      methodError(error)
    }
  })

  sessionPlugin.registerMethod('use', async (input, context) => {
    try {
      unknownFields(input, ['workspace'])
      const value = input.workspace
      if (value !== null && value !== undefined && typeof value !== 'string') {
        throw new PluginMethodError(400, 'workspace 必须是字符串或 null')
      }
      const snapshot = await runtime.use(
        runtimeContext(context.extensionContext),
        typeof value === 'string' ? value : null
      )
      updateStatus(context.extensionContext)
      return jsonObject(snapshot)
    } catch (error) {
      methodError(error)
    }
  })

  sessionPlugin.registerMethod('run', async (input, context) => {
    try {
      const result = await runtime.run(
        runtimeContext(context.extensionContext),
        runInput(input),
        context.extensionContext.signal
      )
      updateStatus(context.extensionContext)
      return jsonObject(result)
    } catch (error) {
      methodError(error)
    }
  })

  const stopExternalOperationListener = pi.events.on(WORKSPACE_OPERATION_EVENT, async (value) => {
    const operation = parseWorkspaceExternalOperation(value)
    if (!operation || !currentContext) return
    await runtime.recordExternalOperation(runtimeContext(currentContext), operation)
  })

  pi.on('session_start', async (_event, context) => restore(context))
  pi.on('session_tree', async (_event, context) => restore(context))
  pi.on('session_shutdown', () => {
    currentContext = undefined
    stopExternalOperationListener()
    runtime.shutdown()
  })

  pi.on('resources_discover', async (_event, context) => {
    if (!context.isProjectTrusted()) return
    const { config } = await loadConfigForSession(context.cwd)
    if (config) registerAgentIntegration()
  })

  function registerAgentIntegration(): void {
    if (agentIntegrationRegistered) return
    agentIntegrationRegistered = true

    pi.on('before_agent_start', async (event, context) => {
      const workspaceContext = await runtime.promptContext(runtimeContext(context))
      if (!workspaceContext) return
      return { systemPrompt: `${event.systemPrompt}\n\n${workspaceContext}` }
    })

    pi.registerTool({
      name: 'workspace',
      label: 'Workspace',
      description:
        '获取并操作项目隔离工作区。action：list、info、acquire、use、run。acquire 返回初始化完成的 workspace root；run 执行项目声明的 Node Command。',
      promptSnippet: '获取初始化完成的隔离目录并执行其项目命令',
      promptGuidelines: [
        'Use workspace acquire when a task needs an isolated working directory. Set requirement to a concise, single-line task name of at most 20 characters, not a task description; then operate only inside the returned workspace root path.',
        'Use workspace run for lifecycle and project commands declared by the active workspace; do not run Workspace Handler files manually.'
      ],
      parameters: toolInputSchema,
      async execute(_toolCallId, input: ToolInput, signal, onUpdate, context) {
        const current = runtimeContext(context)
        let value: unknown

        if (input.action === 'list') {
          value = await runtime.snapshot(current)
        } else if (input.action === 'info') {
          const snapshot = await runtime.snapshot(current)
          value = {
            workspace: workspaceFromSnapshot(snapshot, input.workspace),
            definitions: snapshot.definitions
          }
        } else if (input.action === 'acquire') {
          if (!input.definition || !input.requirement) {
            throw new WorkspaceError('acquire 必须提供 definition 和 requirement')
          }
          const result = await runtime.acquire(
            current,
            {
              definition: input.definition,
              requirement: input.requirement,
              ...(input.parameters
                ? { parameters: input.parameters as Record<string, JsonValue> }
                : {})
            },
            signal,
            (message) => onUpdate?.({ content: [{ type: 'text', text: message }], details: {} })
          )
          value = {
            workspaceRef: result.workspaceRef,
            requirement: result.requirement,
            root: result.root,
            definition: result.definition
          }
        } else if (input.action === 'use') {
          const snapshot = await runtime.use(current, input.workspace ?? null)
          value = snapshot.active
            ? {
                active: snapshot.active,
                workspace: workspaceFromSnapshot(snapshot, snapshot.active)
              }
            : { active: null }
        } else {
          if (!input.command) throw new WorkspaceError('run 必须提供 command')
          const result = await runtime.run(
            current,
            {
              command: input.command,
              ...(input.workspace ? { workspace: input.workspace } : {}),
              ...(input.parameters
                ? { parameters: input.parameters as Record<string, JsonValue> }
                : {})
            },
            signal,
            (message) => onUpdate?.({ content: [{ type: 'text', text: message }], details: {} })
          )
          value = {
            workspaceId: result.workspaceId,
            command: result.command,
            ...(result.summary ? { summary: result.summary } : {}),
            logPath: result.logPath
          }
        }

        updateStatus(context)
        return {
          content: [{ type: 'text', text: serialize(value) }],
          details: value
        }
      }
    })
  }
}
