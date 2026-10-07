import 'server-only'

import { randomUUID } from 'node:crypto'
import type {
  AgentSession,
  AgentSessionEvent,
  SessionEntry,
  SessionMessageEntry
} from '@earendil-works/pi-coding-agent'
import type { AgentEvent } from '@earendil-works/pi-agent-core'
import type { PluginJsonObject, PluginJsonValue } from '@jetcrab/pi-desk-sdk'
import {
  projectL4PiLiveToolResultMessage,
  projectL4PiToolCallDisplay,
  readL4PiToolCalls,
  type L4PiChatMessage,
  type L4PiToolCallDisplay,
  type L4PiToolCallDisplayCache,
  type L4PiToolCallSnapshot
} from './l4-pi-chat-projection'

export type L4PiAgentToolRuntimeEvent =
  | { type: 'message_start'; tempId: string; message: L4PiChatMessage }
  | { type: 'message_update'; tempId: string; message: L4PiChatMessage }
  | { type: 'message_discard'; tempId: string }

interface L4PiAgentToolRecord {
  tempId: string
  toolCallId: string
  name: string
  display: L4PiToolCallDisplay
  displayCache: L4PiToolCallDisplayCache
  input: Record<string, unknown>
  partialResult: unknown
  result: unknown
  status: 'running' | 'completed' | 'error'
  startedAtMs: number | null
  durationMs: number | null
}

interface L4PiAgentToolRuntimeLeaseRecord {
  runtime: L4PiAgentToolRuntime
  references: number
}

export interface L4PiAgentToolRuntimeLease {
  runtime: L4PiAgentToolRuntime
  release: () => void
}

type L4PiAgentToolRuntimeListener = (event: L4PiAgentToolRuntimeEvent) => void

const runtimeBySession = new WeakMap<AgentSession, L4PiAgentToolRuntimeLeaseRecord>()

function sameToolDisplay(left: L4PiToolCallDisplay, right: L4PiToolCallDisplay): boolean {
  return (
    left.reasoning === right.reasoning &&
    left.inputPreview === right.inputPreview &&
    left.activity === right.activity
  )
}

function pluginJsonValue(value: unknown): PluginJsonValue {
  try {
    const serialized = JSON.stringify(value)
    return serialized === undefined ? null : (JSON.parse(serialized) as PluginJsonValue)
  } catch {
    return null
  }
}

function pluginJsonObject(value: unknown): PluginJsonObject {
  const json = pluginJsonValue(value)
  return json && typeof json === 'object' && !Array.isArray(json) ? json : {}
}

function persistBashToolDuration(result: unknown, durationMs: number): void {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return
  const record = result as { details?: unknown }
  const details =
    record.details && typeof record.details === 'object' && !Array.isArray(record.details)
      ? record.details
      : {}
  record.details = { ...details, durationMs }
}

function pendingToolCalls(branch: readonly SessionEntry[]): L4PiToolCallSnapshot[] {
  const pending = new Map<string, L4PiToolCallSnapshot>()
  for (const entry of branch) {
    if (entry.type !== 'message') continue
    if (entry.message.role === 'assistant') {
      for (const call of readL4PiToolCalls(entry.message.content)) pending.set(call.id, call)
    } else if (entry.message.role === 'toolResult') {
      pending.delete(entry.message.toolCallId)
    }
  }
  return [...pending.values()]
}

export class L4PiAgentToolRuntime {
  private readonly listeners = new Set<L4PiAgentToolRuntimeListener>()
  private readonly toolsById = new Map<string, L4PiAgentToolRecord>()
  private readonly unsubscribeAgent: () => void
  private readonly unsubscribeSession: () => void
  private disposed = false

  constructor(private readonly session: AgentSession) {
    this.unsubscribeAgent = session.agent.subscribe((event) => this.captureAgentEvent(event))
    this.unsubscribeSession = session.subscribe((event) => this.captureSessionEvent(event))

    const branch = session.sessionManager.getBranch()
    const pendingIds = session.agent.state.pendingToolCalls
    for (const call of pendingToolCalls(branch)) {
      if (pendingIds.has(call.id)) this.upsertTool(call.id, call.name, call.input)
    }
    const streaming = session.agent.state.streamingMessage
    if (streaming) this.syncStreamingTools(streaming, false)
  }

  get size(): number {
    return this.toolsById.size
  }

  subscribe(listener: L4PiAgentToolRuntimeListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  activeMessages(): Array<{ tempId: string; message: L4PiChatMessage }> {
    return [...this.toolsById.values()].map((tool) => ({
      tempId: tool.tempId,
      message: this.toolMessage(tool)
    }))
  }

  tempId(toolCallId: string): string | null {
    return this.toolsById.get(toolCallId)?.tempId ?? null
  }

  syncStreamingTools(message: SessionMessageEntry['message'], publish = true): void {
    if (message.role !== 'assistant') return
    for (const call of readL4PiToolCalls(message.content)) {
      const { tool, created, changed } = this.upsertTool(call.id, call.name, call.input)
      if (!publish) continue
      if (created) {
        this.publish({
          type: 'message_start',
          tempId: tool.tempId,
          message: this.toolMessage(tool)
        })
      } else if (changed) {
        this.publishToolUpdate(tool)
      }
    }
  }

  projectLiveResult(
    message: SessionMessageEntry['message'],
    toolCallId: string
  ): L4PiChatMessage | null {
    const tool = this.toolsById.get(toolCallId)
    return projectL4PiLiveToolResultMessage(message, toolCallId, tool?.display, tool?.input)
  }

  remove(toolCallId: string): void {
    this.toolsById.delete(toolCallId)
  }

  discardAll(): void {
    for (const tool of this.toolsById.values()) {
      this.publish({ type: 'message_discard', tempId: tool.tempId })
    }
    this.toolsById.clear()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.unsubscribeAgent()
    this.unsubscribeSession()
    this.listeners.clear()
    this.toolsById.clear()
  }

  private captureAgentEvent(event: AgentEvent): void {
    if (this.disposed) return
    // 子调用只有父 ToolResult 中的记录，没有独立 durable entry，不能创建聊天临时项。
    if ('parentToolCallId' in event && event.parentToolCallId !== undefined) return
    switch (event.type) {
      case 'tool_execution_start':
        this.startTool(event.toolCallId, event.toolName, event.args)
        return
      case 'tool_execution_update':
        this.updateTool(event.toolCallId, event.toolName, event.args, event.partialResult)
        return
      case 'tool_execution_end':
        this.endTool(event.toolCallId, event.toolName, event.result, event.isError)
        return
      case 'turn_end':
        // 本轮结果已提交；中断后未执行的流式调用也必须释放，不能等整个会话 settled。
        this.discardAll()
        return
      default:
        return
    }
  }

  private captureSessionEvent(event: AgentSessionEvent): void {
    if ((event.type === 'agent_end' && event.willRetry) || event.type === 'agent_settled') {
      queueMicrotask(() => {
        if (!this.disposed) this.discardAll()
      })
    }
  }

  private upsertTool(
    toolCallId: string,
    toolName: string,
    args: unknown
  ): { tool: L4PiAgentToolRecord; created: boolean; changed: boolean } {
    const input: Record<string, unknown> =
      args && typeof args === 'object' && !Array.isArray(args)
        ? { ...(args as Record<string, unknown>) }
        : {}
    const existing = this.toolsById.get(toolCallId)
    if (existing) {
      const display = projectL4PiToolCallDisplay(toolName, input, existing.displayCache)
      const changed = existing.name !== toolName || !sameToolDisplay(existing.display, display)
      existing.name = toolName
      existing.input = input
      existing.display = display
      return { tool: existing, created: false, changed }
    }

    const displayCache: L4PiToolCallDisplayCache = {}
    const tool: L4PiAgentToolRecord = {
      tempId: randomUUID(),
      toolCallId,
      name: toolName,
      display: projectL4PiToolCallDisplay(toolName, input, displayCache),
      displayCache,
      input,
      partialResult: null,
      result: null,
      status: 'running',
      startedAtMs: null,
      durationMs: null
    }
    this.toolsById.set(toolCallId, tool)
    return { tool, created: true, changed: true }
  }

  private startTool(toolCallId: string, toolName: string, args: unknown): void {
    const { tool, created, changed } = this.upsertTool(toolCallId, toolName, args)
    const startsBash = toolName === 'bash' && tool.startedAtMs === null
    tool.status = 'running'
    if (startsBash) tool.startedAtMs = Date.now()
    if (created) {
      this.publish({ type: 'message_start', tempId: tool.tempId, message: this.toolMessage(tool) })
    } else if (changed || startsBash) {
      this.publishToolUpdate(tool)
    }
  }

  private updateTool(
    toolCallId: string,
    toolName: string,
    args: unknown,
    partialResult: unknown
  ): void {
    this.startTool(toolCallId, toolName, args)
    const tool = this.toolsById.get(toolCallId)
    if (!tool) return
    tool.partialResult = partialResult
    tool.status = 'running'
    this.publishToolUpdate(tool)
  }

  private endTool(toolCallId: string, toolName: string, result: unknown, isError: boolean): void {
    if (!this.toolsById.has(toolCallId)) this.startTool(toolCallId, toolName, {})
    const tool = this.toolsById.get(toolCallId)
    if (!tool) return
    if (tool.name === 'bash' && tool.startedAtMs !== null) {
      tool.durationMs = Math.max(0, Date.now() - tool.startedAtMs)
      persistBashToolDuration(result, tool.durationMs)
    }
    tool.result = result
    tool.status = isError ? 'error' : 'completed'
    this.publishToolUpdate(tool)
  }

  private publishToolUpdate(tool: L4PiAgentToolRecord): void {
    this.publish({
      type: 'message_update',
      tempId: tool.tempId,
      message: this.toolMessage(tool)
    })
  }

  private toolMessage(tool: L4PiAgentToolRecord): L4PiChatMessage {
    return {
      type: 'tool',
      name: tool.name,
      reasoning: tool.display.reasoning,
      inputPreview: tool.display.inputPreview,
      activity: tool.display.activity,
      status: tool.status,
      usage: null,
      output: '',
      startedAtMs: tool.startedAtMs,
      durationMs: tool.durationMs,
      declaration: {
        message: {
          kind: 'tool',
          toolName: tool.name,
          toolCallId: tool.toolCallId,
          arguments: pluginJsonObject(tool.input),
          partialResult: pluginJsonValue(tool.partialResult),
          result: pluginJsonValue(tool.result),
          isError: tool.status === 'error'
        },
        raw: {
          toolCallId: tool.toolCallId,
          toolName: tool.name,
          args: tool.input,
          partialResult: tool.partialResult,
          result: tool.result
        }
      }
    }
  }

  private publish(event: L4PiAgentToolRuntimeEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event)
      } catch (error) {
        console.error('[Pi Desk][AgentToolRuntime] 事件监听器执行失败', {
          sessionId: this.session.sessionId,
          eventType: event.type,
          errorName: error instanceof Error ? error.name : 'UnknownError'
        })
      }
    }
  }
}

export function retainL4PiAgentToolRuntime(session: AgentSession): L4PiAgentToolRuntimeLease {
  let record = runtimeBySession.get(session)
  if (!record) {
    record = { runtime: new L4PiAgentToolRuntime(session), references: 0 }
    runtimeBySession.set(session, record)
  }
  record.references += 1
  let released = false
  return {
    runtime: record.runtime,
    release: () => {
      if (released) return
      released = true
      record!.references -= 1
      if (record!.references > 0) return
      runtimeBySession.delete(session)
      record!.runtime.dispose()
    }
  }
}
