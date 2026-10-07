import {
  definePiDeskPlugin,
  type PluginJsonObject,
  type PluginJsonValue,
  type PluginMessageDeclarationInput,
  type PluginMessageProjectionResult
} from '@jetcrab/pi-desk-sdk/entry'
import { collectSubagentCapabilityOptions } from './agent-config.js'
import { getGlobalSubagentSettings, saveGlobalSubagentSettings } from './global-settings.js'
import {
  SUBAGENT_COMPLETION_CUSTOM_TYPE,
  parseSubagentCompletionContent
} from './subagent-message.js'

type SubagentTerminalStatus = 'completed' | 'failed' | 'stopped' | 'interrupted'

function record(value: PluginJsonValue): PluginJsonObject | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null
}

function text(value: PluginJsonValue | undefined): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function resultDetails(value: PluginJsonValue): PluginJsonObject | null {
  return record(record(value)?.details ?? null)
}

function resultOutput(value: PluginJsonValue): string | null {
  const result = record(value)
  const output = text(result?.output)
  if (output) return output
  const content = result?.content
  if (!Array.isArray(content)) return text(content)
  const parts = content.flatMap((part) => {
    const item = record(part)
    return item?.type === 'text' && typeof item.text === 'string' ? [item.text] : []
  })
  const combined = parts.join('\n').trim()
  return combined || null
}

function terminalStatus(value: PluginJsonValue | undefined): SubagentTerminalStatus | null {
  return value === 'completed' ||
    value === 'failed' ||
    value === 'stopped' ||
    value === 'interrupted'
    ? value
    : null
}

export function projectSubagentStartMessage(
  input: PluginMessageDeclarationInput
): PluginMessageProjectionResult {
  if (input.message.kind !== 'tool') return input.defaultProjection
  const argumentsValue = input.message.arguments
  const details = resultDetails(input.message.result)
  const action = input.message.toolName === 'agent_resume' ? 'resume' : 'start'
  const agentType = text(argumentsValue.subagent_type) ?? text(details?.agentType)
  const resumeId = text(argumentsValue.agent_id)
  const title = text(argumentsValue.description) ?? text(details?.title) ?? '子代理任务'
  const prompt = text(argumentsValue.prompt)
  return {
    viewKey: 'subagent/start',
    summary: {
      action,
      taskId: text(details?.taskId) ?? resumeId,
      agentType,
      title,
      error: input.message.isError ? resultOutput(input.message.result) : null
    },
    detail: prompt ? { markdown: prompt } : null
  }
}

export function projectSubagentReturnMessage(
  input: PluginMessageDeclarationInput
): PluginMessageProjectionResult {
  if (input.message.kind !== 'custom') return input.defaultProjection
  const details = record(input.message.details)
  const content = parseSubagentCompletionContent(input.message.content)
  return {
    viewKey: 'subagent/return',
    summary: {
      taskId: text(details?.taskId),
      agentType: content.agentType,
      title: content.title ?? '子代理任务',
      status: terminalStatus(details?.status) ?? 'failed'
    },
    detail: content.result ? { markdown: content.result } : null
  }
}

export function projectSubagentListMessage(
  input: PluginMessageDeclarationInput
): PluginMessageProjectionResult {
  if (input.message.kind !== 'tool') return input.defaultProjection
  const details = resultDetails(input.message.result)
  const agents = Array.isArray(details?.agents) ? details.agents : null
  const output = resultOutput(input.message.result)
  return {
    viewKey: 'subagent/list',
    summary: {
      query: text(input.message.arguments.agent_id),
      agents,
      error: input.message.isError ? output : null
    },
    detail: !agents && !input.message.isError && output ? { output } : null
  }
}

export function projectSubagentControlMessage(
  input: PluginMessageDeclarationInput
): PluginMessageProjectionResult {
  if (input.message.kind !== 'tool') return input.defaultProjection
  const details = resultDetails(input.message.result)
  const action = input.message.toolName === 'agent_stop' ? 'stop' : 'steer'
  const taskId = text(details?.taskId) ?? text(input.message.arguments.agent_id)
  const output = resultOutput(input.message.result)
  const prompt = text(input.message.arguments.prompt)
  const preview = prompt ? Array.from(prompt.replace(/\s+/gu, ' ')) : null
  return {
    viewKey: 'subagent/control',
    summary: {
      action,
      taskId,
      agentType: text(details?.agentType),
      title: text(details?.title) ?? '子代理任务',
      ...(action === 'steer'
        ? {
            preview: preview
              ? preview.length > 160
                ? `${preview.slice(0, 159).join('')}…`
                : preview.join('')
              : null
          }
        : {}),
      delivery:
        action === 'steer'
          ? (text(details?.delivery) ?? (output?.startsWith('补充条件已排队') ? 'queued' : null))
          : null,
      error: input.message.isError ? output : null
    },
    detail: prompt ? { markdown: prompt } : null
  }
}

export default definePiDeskPlugin({
  name: 'subagent',
  setup(plugin) {
    plugin.registerMethod('settings-get', () => getGlobalSubagentSettings())
    plugin.registerMethod('settings-save', (input) => saveGlobalSubagentSettings(input))
    plugin.registerBrowserEntry('./dist/browser/entry.js')
    plugin.declareCapabilities(async ({ signal }) => {
      const workSessions = await plugin.host.workSessions.listWorkSessions()
      return {
        agents: {
          label: '子代理',
          options: collectSubagentCapabilityOptions(
            workSessions.map((session) => session.cwd),
            signal
          )
        }
      }
    })
    plugin.declareMessage('start', {
      priority: 100,
      match: (input) =>
        input.message.kind === 'tool' &&
        (input.message.toolName === 'agent' || input.message.toolName === 'agent_resume'),
      project: projectSubagentStartMessage
    })
    plugin.declareMessage('list', {
      priority: 100,
      match: (input) => input.message.kind === 'tool' && input.message.toolName === 'agent_list',
      project: projectSubagentListMessage
    })
    plugin.declareMessage('control', {
      priority: 100,
      match: (input) =>
        input.message.kind === 'tool' &&
        (input.message.toolName === 'agent_stop' || input.message.toolName === 'agent_steer'),
      project: projectSubagentControlMessage
    })
    plugin.declareMessage('return', {
      priority: 100,
      match: (input) =>
        input.message.kind === 'custom' &&
        (input.message.customType === SUBAGENT_COMPLETION_CUSTOM_TYPE ||
          input.message.customType === 'pi-super-subagent:completion:v1'),
      project: projectSubagentReturnMessage
    })
  }
})
