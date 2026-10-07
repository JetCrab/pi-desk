import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { ExtensionFactory } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import type { SubagentConfig } from './agent-config.js'

export const RESEARCH_WORKER_AGENT_TYPE = 'research-worker'

const RESEARCH_WORKER_PROMPT = readFileSync(
  fileURLToPath(new URL('../agents/internal/research-worker.md', import.meta.url)),
  'utf8'
).trim()
const RESEARCH_WORKER_TOOLS = new Set(['external_research', 'read', 'grep', 'find', 'ls'])
const MAX_WORKER_RESULT_BYTES = 20_000
const MAX_DELEGATE_OUTPUT_BYTES = 50 * 1024

export interface ResearchDelegateTask {
  title: string
  prompt: string
}

export type ResearchWorkerStatus = 'completed' | 'failed' | 'stopped' | 'interrupted'

export interface ResearchWorkerOutcome {
  taskId: string | null
  title: string
  status: ResearchWorkerStatus
  result: string | null
  error: string | null
  sessionFile: string | null
}

export interface ResearchDelegateProgress {
  completed: number
  total: number
}

export type ResearchWorkerDelegate = (
  tasks: readonly ResearchDelegateTask[],
  signal: AbortSignal | undefined,
  onProgress: (progress: ResearchDelegateProgress) => void
) => Promise<ResearchWorkerOutcome[]>

function requireText(value: string, field: string): string {
  const text = value.trim()
  if (!text) throw new Error(`${field} 不能为空`)
  return text
}

function truncateUtf8(value: string, maxBytes: number): string {
  const content = Buffer.from(value, 'utf8')
  if (content.byteLength <= maxBytes) return value
  let end = Math.max(0, maxBytes)
  while (end > 0 && (content[end]! & 0xc0) === 0x80) end -= 1
  return content.subarray(0, end).toString('utf8')
}

function visibleWorkerResult(outcome: ResearchWorkerOutcome, maxBytes: number): string {
  const body = outcome.result ?? outcome.error ?? '(没有结果)'
  if (Buffer.byteLength(body, 'utf8') <= maxBytes) return body
  const marker = `\n\n[结果已截断；完整 Conversation：${outcome.sessionFile ?? '未保存'}]`
  return `${truncateUtf8(body, Math.max(0, maxBytes - Buffer.byteLength(marker, 'utf8')))}${marker}`
}

function formatOutcomes(outcomes: readonly ResearchWorkerOutcome[]): string {
  const completed = outcomes.filter((outcome) => outcome.status === 'completed').length
  const header = `Research Worker：${completed}/${outcomes.length} 完成\n\n`
  const perWorkerBytes = Math.min(
    MAX_WORKER_RESULT_BYTES,
    Math.max(
      256,
      Math.floor((MAX_DELEGATE_OUTPUT_BYTES - Buffer.byteLength(header)) / outcomes.length)
    )
  )
  const sections = outcomes.map(
    (outcome) =>
      `### [${outcome.title}] ${outcome.status}\n\n${visibleWorkerResult(outcome, perWorkerBytes)}`
  )
  const content = `${header}${sections.join('\n\n---\n\n')}`
  if (Buffer.byteLength(content, 'utf8') <= MAX_DELEGATE_OUTPUT_BYTES) return content
  const marker = '\n\n[聚合结果已截断；完整结果保留在各 Worker Conversation。]'
  return `${truncateUtf8(
    content,
    MAX_DELEGATE_OUTPUT_BYTES - Buffer.byteLength(marker, 'utf8')
  )}${marker}`
}

export function createResearchWorkerConfig(research: SubagentConfig): SubagentConfig {
  return {
    name: RESEARCH_WORKER_AGENT_TYPE,
    description: '执行 Root research 派发的单个独立外部研究轨道。',
    tools: research.tools.filter((tool) => RESEARCH_WORKER_TOOLS.has(tool)),
    model: research.model,
    thinking: research.thinking,
    systemPrompt: RESEARCH_WORKER_PROMPT
  }
}

export function createResearchCoordinatorExtension(
  delegate: ResearchWorkerDelegate
): ExtensionFactory {
  return (pi) => {
    pi.registerTool({
      name: 'research_delegate',
      label: 'Research Delegate',
      description:
        '将至少两个范围互不依赖的外部研究轨道并行交给叶子 Research Worker，并等待全部 Worker 进入终态。',
      promptSnippet: '并行委派至少两个互不依赖的外部研究轨道，并等待全部结果。',
      promptGuidelines: [
        '研究对象未知的模糊需求先做表层探索，只获取候选清单和分片依据；发现至少两个独立对象或问题后再调用 research_delegate。',
        '尽量拆分到一个 Worker 只负责一个明确对象或一个单一可交付问题；不要把可独立研究的多个对象打包给同一个 Worker，也不要机械切碎同一个不可分问题。',
        'research_delegate 返回前 Root research 停止重复研究相同范围，并等待全部 Worker 进入终态。'
      ],
      parameters: Type.Object({
        tasks: Type.Array(
          Type.Object({
            title: Type.String({ description: '任务中心展示的简短研究标题' }),
            prompt: Type.String({ description: '完整、自包含的单轨道研究任务' })
          }),
          { minItems: 2, description: '至少两个互不依赖的研究轨道' }
        )
      }),
      async execute(_toolCallId, params, signal, onUpdate) {
        const tasks = params.tasks.map((task, index) => ({
          title: requireText(task.title, `tasks[${index}].title`),
          prompt: requireText(task.prompt, `tasks[${index}].prompt`)
        }))
        const outcomes = await delegate(tasks, signal, (progress) => {
          onUpdate?.({
            content: [
              {
                type: 'text',
                text: `Research Worker：${progress.completed}/${progress.total} 已进入终态`
              }
            ],
            details: progress
          })
        })
        return {
          content: [{ type: 'text', text: formatOutcomes(outcomes) }],
          details: {
            version: 1,
            workers: outcomes.map((outcome) => ({
              taskId: outcome.taskId,
              title: outcome.title,
              status: outcome.status,
              sessionFile: outcome.sessionFile
            }))
          }
        }
      }
    })
  }
}
