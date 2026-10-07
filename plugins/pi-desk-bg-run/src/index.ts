import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import { BackgroundTaskRuntime } from './background-runtime.js'

const BgRunParameters = Type.Object({
  name: Type.String({
    minLength: 1,
    maxLength: 80,
    description: '用于任务中心展示的简短任务名称，建议 2-6 个词'
  }),
  command: Type.String({
    minLength: 1,
    description: '需要在主流程继续工作时保持运行的 Shell 命令'
  }),
  timeoutSeconds: Type.Optional(
    Type.Integer({
      minimum: 1,
      description: '可选超时时间（秒）；省略时持续运行，直到进程结束或被停止'
    })
  )
})

const BgStatusParameters = Type.Object({
  taskId: Type.Optional(Type.String({ description: '可选的完整任务 ID 或可唯一匹配的 ID 前缀' }))
})

const BgKillParameters = Type.Object({
  taskId: Type.String({ description: '要停止的完整任务 ID 或可唯一匹配的 ID 前缀' })
})

export default function backgroundRunExtension(pi: ExtensionAPI): void {
  const runtime = new BackgroundTaskRuntime(pi)

  pi.on('session_start', (_event, ctx) => {
    runtime.startSession(ctx)
  })
  pi.on('session_before_tree', async (event, ctx) => {
    try {
      return await runtime.beforeTree(event.signal)
    } catch (error) {
      console.error('[pi-desk-bg-run] 树导航前停止后台任务失败', error)
      ctx.ui.notify(
        `无法切换分支：${error instanceof Error ? error.message : String(error)}`,
        'error'
      )
      return { cancel: true }
    }
  })
  pi.on('session_tree', (_event, ctx) => {
    runtime.startSession(ctx)
  })
  pi.on('session_shutdown', async () => {
    await runtime.shutdown()
  })

  pi.registerTool({
    name: 'bg_run',
    label: 'Background Run',
    description:
      '在当前项目后台启动具名 Shell 命令并立即返回任务 ID；输出写入 temp/pi/pi-desk-bg-run，单任务最多 20MB。',
    promptSnippet: '后台运行需要在主流程继续工作时保持执行的 Shell 命令',
    promptGuidelines: [
      'bg_run 是单向后台启动工具：立即返回任务 ID，不等待执行结果，也不会在任务完成后自动让助手继续。主要用于启动服务等需要在后续工作期间保持运行的进程；仅当还有不依赖其结果的独立工作时使用，不能仅因命令耗时长就使用。测试、构建、验收等需要等待结果的命令，使用 bash 同步执行并按需设置 timeout；查询状态、读取进度不算独立工作。',
      '后台子代理使用 agent，不要通过 bg_run 启动 Pi 或其他 Agent。',
      'bg_run 返回后继续独立工作，不要连续查询未变化的状态或重复读取相同日志。'
    ],
    parameters: BgRunParameters,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (signal?.aborted) throw new Error('后台任务启动已取消')
      const task = await runtime.startTask(ctx, params)
      return {
        content: [
          {
            type: 'text',
            text: `后台任务已启动。\n\nTask ID: ${task.taskId}\nName: ${task.name}\nPID: ${task.pid ?? 'unknown'}\nOutput: ${task.outputPath}`
          }
        ],
        details: { task }
      }
    }
  })

  pi.registerTool({
    name: 'bg_status',
    label: 'Background Status',
    description: '查看一个后台任务，或列出当前 Session 中的后台任务。',
    promptSnippet: '查看后台任务状态',
    promptGuidelines: [
      '需要确认 bg_run 任务是否结束时使用 bg_status；需要日志正文时读取任务的输出路径。'
    ],
    parameters: BgStatusParameters,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const tasks = runtime.listTasks(ctx, params.taskId)
      return {
        content: [{ type: 'text', text: runtime.formatTasks(tasks) }],
        details: { tasks }
      }
    }
  })

  pi.registerTool({
    name: 'bg_kill',
    label: 'Background Kill',
    description: '按任务 ID 停止一个仍在运行的后台任务及其完整进程树。',
    promptSnippet: '停止后台任务进程树',
    promptGuidelines: ['bg_run 任务用完后，调用 bg_kill 停止仍在运行的任务。'],
    parameters: BgKillParameters,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const task = await runtime.stopTaskById(ctx, params.taskId)
      return {
        content: [
          {
            type: 'text',
            text: `后台任务已停止。\n\nTask ID: ${task.taskId}\nName: ${task.name}\nOutput: ${task.outputPath}`
          }
        ],
        details: { task }
      }
    }
  })
}
