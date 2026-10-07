import type { ToolResultMessage } from '@earendil-works/pi-ai'
import type { ExtensionAPI, SessionEntry } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'

export const HISTORY_TOOL_RESULT_NAME = 'history_tool_result'

type HistoricalToolStatus = 'ok' | 'error' | 'missing'

type HistoricalToolMatch = {
  toolCallId: string
  toolName: string
  result?: ToolResultMessage
}

export type HistoricalToolResultDetails = {
  ref: number
  toolCallId: string
  toolName: string
  historicalStatus: HistoricalToolStatus
  timestamp?: number
}

function findHistoricalToolMatch(
  entries: SessionEntry[],
  toolCallId: string
): HistoricalToolMatch | undefined {
  let toolName: string | undefined
  let result: ToolResultMessage | undefined

  for (const entry of entries) {
    if (entry.type !== 'message') continue
    const message = entry.message

    if (message.role === 'assistant') {
      for (const block of message.content) {
        if (block.type === 'toolCall' && block.id === toolCallId) {
          toolName = block.name
          break
        }
      }
      continue
    }

    if (message.role === 'toolResult' && message.toolCallId === toolCallId) {
      result = message
    }
  }

  if (toolName === undefined) return undefined
  return { toolCallId, toolName, result }
}

function formatTimestamp(timestamp: number): string {
  const date = new Date(timestamp)
  return Number.isNaN(date.getTime()) ? String(timestamp) : date.toISOString()
}

function createHistoryHeader(
  ref: number,
  match: HistoricalToolMatch,
  status: HistoricalToolStatus
): string {
  const timestamp = match.result ? `，timestamp=${formatTimestamp(match.result.timestamp)}` : ''
  return `历史 ToolResult：ref=${ref}，tool=${match.toolName}，status=${status}${timestamp}。这是当时快照，不代表当前状态。`
}

export function registerHistoryToolResult(
  pi: ExtensionAPI,
  getToolReferences: () => ReadonlyMap<number, string>
): void {
  pi.registerTool({
    name: HISTORY_TOOL_RESULT_NAME,
    label: 'History Tool Result',
    description:
      '仅在确实需要当时原始结果时，按当前 compressed_tool_context 中的 ref 只读返回完整历史 ToolResult。该结果不是当前状态；需要最新结果时重新调用原工具。',
    parameters: Type.Object(
      {
        ref: Type.Integer({
          minimum: 1,
          description: 'compressed_tool_context 记录中的历史工具引用序号'
        })
      },
      { additionalProperties: false }
    ),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const historicalToolCallId = getToolReferences().get(params.ref)
      if (historicalToolCallId === undefined) {
        throw new Error(
          `当前模型上下文中不存在历史工具引用 ref=${params.ref}，请使用当前 compressed_tool_context 中的 ref。`
        )
      }

      const match = findHistoricalToolMatch(ctx.sessionManager.getBranch(), historicalToolCallId)
      if (match === undefined) {
        throw new Error(`历史工具引用 ref=${params.ref} 已不属于当前 Session 分支。`)
      }

      if (match.result === undefined) {
        return {
          content: [
            {
              type: 'text',
              text: createHistoryHeader(params.ref, match, 'missing')
            }
          ],
          details: {
            ref: params.ref,
            toolCallId: match.toolCallId,
            toolName: match.toolName,
            historicalStatus: 'missing'
          } satisfies HistoricalToolResultDetails
        }
      }

      const historicalStatus = match.result.isError ? 'error' : 'ok'
      return {
        content: [
          {
            type: 'text',
            text: createHistoryHeader(params.ref, match, historicalStatus)
          },
          ...match.result.content.map((block) => ({ ...block }))
        ],
        details: {
          ref: params.ref,
          toolCallId: match.toolCallId,
          toolName: match.toolName,
          historicalStatus,
          timestamp: match.result.timestamp
        } satisfies HistoricalToolResultDetails
      }
    }
  })
}
