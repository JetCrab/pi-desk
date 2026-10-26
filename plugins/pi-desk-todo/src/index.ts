import type { AgentToolResult, ExtensionAPI } from '@earendil-works/pi-coding-agent'
import {
  bindSessionPlugin,
  PluginMethodError,
  type PluginJsonObject
} from '@jetcrab/pi-desk-sdk/session'
import { TodoInputSchema } from './schema.js'
import { TodoRuntime } from './runtime.js'

const TOOL_GUIDANCE =
  'Todo仅用于向用户展示当前工作的实际进度，不是开发计划，也不得作为后续执行依据。以用户要求、项目资料和实际结果为准，随实际情况增删、重排和修正状态；每次完整替换，不为完成清单做不需要的工作。'

function emptyInput(input: PluginJsonObject): void {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    Object.keys(input).length !== 0
  ) {
    throw new PluginMethodError(400, 'Todo get/hide 输入只允许空对象 {}')
  }
}

export default function extension(pi: ExtensionAPI): void {
  const plugin = bindSessionPlugin(pi, 'todo')
  const runtime = new TodoRuntime(plugin)

  plugin.registerMethod('get', async (input): Promise<PluginJsonObject> => {
    emptyInput(input)
    return runtime.get()
  })
  plugin.registerMethod('hide', async (input): Promise<PluginJsonObject> => {
    emptyInput(input)
    return runtime.hide()
  })

  pi.registerTool({
    name: 'todo',
    label: 'Todo',
    description: TOOL_GUIDANCE,
    promptSnippet: '向用户展示当前工作的实际进度，每次全量替换。',
    promptGuidelines: [TOOL_GUIDANCE],
    parameters: TodoInputSchema,
    executionMode: 'sequential',
    async execute(_toolCallId, input): Promise<AgentToolResult<undefined>> {
      runtime.replace(input)
      return {
        content: [{ type: 'text', text: '已更新当前工作进度。' }],
        details: undefined
      }
    }
  })

  pi.on('session_start', (): void => runtime.clear())
  pi.on('session_tree', (): void => runtime.clear())
  pi.on('session_shutdown', (): void => runtime.clear())
}
