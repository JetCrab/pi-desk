import {
  L3ConversationAssistantDetailSchema,
  L3ConversationAssistantSummarySchema,
  L3ConversationBashDetailSchema,
  L3ConversationBashSummarySchema,
  L3ConversationBashToolSummarySchema,
  L3ConversationCompactionDetailSchema,
  L3ConversationCodemodeSummarySchema,
  L3ConversationCodemodeDetailSchema,
  L3ConversationCustomSummarySchema,
  L3ConversationEditDetailSchema,
  L3ConversationEditSummarySchema,
  L3ConversationGenericToolDetailSchema,
  L3ConversationGenericToolSummarySchema,
  L3ConversationReadDetailSchema,
  L3ConversationReadSummarySchema,
  L3ConversationUserSummarySchema,
  L3ConversationWriteDetailSchema,
  L3ConversationWriteSummarySchema,
  type L3ConversationBashToolTiming,
  type L3ConversationDurableMessageSnapshot,
  type L3ConversationImageMetadata,
  type L3ConversationMessageUsage,
  type L3ConversationState,
  type L3ConversationTemporaryMessageSnapshot
} from '@common/l3_modules/conversation/l3-conversation-contract'

import {
  L3ConversationPiDeskDetailSchema,
  L3ConversationPiDeskSummarySchema
} from '@common/l3_modules/conversation/l3-conversation-pidesk'

interface L3ConversationDisplayToolSummaryBase {
  type: 'tool'
  name: string
  reasoning: string | null
  inputPreview: string | null
  activity: string | null
  status: 'running' | 'completed' | 'error'
  usage: L3ConversationMessageUsage | null
  hasDetail: boolean
  images?: L3ConversationImageMetadata[]
}

export type L3ConversationDisplaySummary =
  | {
      type: 'user'
      text: string
      images: L3ConversationImageMetadata[]
      hasDetail: false
    }
  | {
      type: 'assistant'
      model?: { provider: string; modelId: string } | null
      text: string
      errorMessage: string | null
      status: 'running' | 'completed' | 'error' | 'aborted'
      usage: L3ConversationMessageUsage
      hasDetail: boolean
    }
  | (L3ConversationDisplayToolSummaryBase & { kind: 'generic' | 'codemode' })
  | (L3ConversationDisplayToolSummaryBase & {
      kind: 'pidesk'
      input: L3ConversationDurableMessageSnapshot['summary']
    })
  | (L3ConversationDisplayToolSummaryBase & {
      kind: 'bash'
      timing: L3ConversationBashToolTiming | null
    })
  | (L3ConversationDisplayToolSummaryBase & {
      kind: 'read' | 'edit' | 'write'
      path: string | null
    })
  | {
      type: 'bash'
      command: string
      status: 'running' | 'completed' | 'error' | 'aborted'
      hasDetail: boolean
    }
  | {
      type: 'custom'
      text: string
      hasDetail: false
    }
  | {
      type: 'compaction'
      hasDetail: boolean
    }

export type L3ConversationDisplayDetail =
  | ({ type: 'assistant' } & ReturnType<typeof L3ConversationAssistantDetailSchema.parse>)
  | ({ type: 'tool'; kind: 'codemode' } & ReturnType<
      typeof L3ConversationCodemodeDetailSchema.parse
    >)
  | { type: 'tool'; kind: 'generic' | 'bash' | 'pidesk'; output: string }
  | { type: 'tool'; kind: 'read'; content: string }
  | {
      type: 'tool'
      kind: 'edit'
      contentKind: 'diff' | 'output'
      content: string
    }
  | {
      type: 'tool'
      kind: 'write'
      contentKind: 'content' | 'output'
      content: string
    }
  | { type: 'bash'; output: string }
  | { type: 'compaction'; text: string }
  | null

export interface L3ConversationDisplayMessage {
  identity: string
  position: number
  viewKey: string
  snapshot: L3ConversationTemporaryMessageSnapshot | L3ConversationDurableMessageSnapshot
  summary: L3ConversationDisplaySummary
  detail: L3ConversationDisplayDetail | undefined
  temporary: boolean
  timestampMs: number | null
  durable: L3ConversationDurableMessageSnapshot | null
  tempId: string | null
  usageCalls?: readonly L3ConversationDisplayMessage[]
  usageIncomplete?: boolean
}

export interface L3ConversationProcessItem {
  message: L3ConversationDisplayMessage
  hideAssistantText: boolean
}

export interface L3ConversationTurn {
  identity: string
  user: L3ConversationDisplayMessage | null
  processItems: L3ConversationProcessItem[]
  finalAssistant: L3ConversationDisplayMessage | null
  compaction: L3ConversationDisplayMessage | null
  running: boolean
  toolCount: number
}

export function formatL3ConversationBashToolDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000))
  const seconds = totalSeconds % 60
  const totalMinutes = Math.floor(totalSeconds / 60)
  if (totalMinutes === 0) return `${seconds}s`

  const minutes = totalMinutes % 60
  const hours = Math.floor(totalMinutes / 60)
  return hours === 0 ? `${minutes}m ${seconds}s` : `${hours}h ${minutes}m ${seconds}s`
}

interface ConversationTimeFormatters {
  locale: string
  timeZone: string
  compactTime: Intl.DateTimeFormat
  compactDateTime: Intl.DateTimeFormat
  fullDateTime: Intl.DateTimeFormat
  dateKey: Intl.DateTimeFormat
}

let conversationTimeFormatters: ConversationTimeFormatters | null = null

function timeFormatters(locale: string, timeZone: string): ConversationTimeFormatters {
  if (
    conversationTimeFormatters?.locale === locale &&
    conversationTimeFormatters.timeZone === timeZone
  ) {
    return conversationTimeFormatters
  }
  const displayLocale = locale === 'en' ? 'en-US' : 'zh-CN'
  conversationTimeFormatters = {
    locale,
    timeZone,
    compactTime: new Intl.DateTimeFormat(displayLocale, {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23'
    }),
    compactDateTime: new Intl.DateTimeFormat(displayLocale, {
      timeZone,
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23'
    }),
    fullDateTime: new Intl.DateTimeFormat(displayLocale, {
      timeZone,
      timeZoneName: 'shortOffset',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23'
    }),
    dateKey: new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    })
  }
  return conversationTimeFormatters
}

interface L3ConversationCachedTemporaryDisplayMessage {
  position: number
  message: L3ConversationDisplayMessage
}

interface L3ConversationDurableTurnPrefix {
  turns: readonly L3ConversationTurn[]
  user: L3ConversationDisplayMessage | null
  body: readonly L3ConversationDisplayMessage[]
}

// 消息和数组都是不可变 Snapshot；按引用缓存可让流式热路径只投影变化的 Temporary 尾部。
const durableDisplayMessageCache = new WeakMap<
  L3ConversationDurableMessageSnapshot,
  L3ConversationDisplayMessage
>()
const temporaryDisplayMessageCache = new WeakMap<
  L3ConversationTemporaryMessageSnapshot,
  L3ConversationCachedTemporaryDisplayMessage
>()
const durableTurnPrefixCache = new WeakMap<
  readonly L3ConversationDurableMessageSnapshot[],
  L3ConversationDurableTurnPrefix
>()

function displayLayers(
  snapshot: L3ConversationTemporaryMessageSnapshot | L3ConversationDurableMessageSnapshot
): {
  summary: L3ConversationDisplaySummary
  detail: L3ConversationDisplayDetail | undefined
} {
  switch (snapshot.fixed.type) {
    case 'user': {
      const parsed = L3ConversationUserSummarySchema.safeParse(snapshot.summary)
      const summary = parsed.success ? parsed.data : { text: '', images: [] }
      return { summary: { type: 'user', ...summary, hasDetail: false }, detail: undefined }
    }
    case 'assistant': {
      const parsed =
        snapshot.fixed.viewKey === 'pi-desk/assistant'
          ? L3ConversationAssistantSummarySchema.safeParse(snapshot.summary)
          : null
      const summary = parsed?.success ? parsed.data : { text: '', errorMessage: null }
      const detail =
        snapshot.fixed.viewKey === 'pi-desk/assistant'
          ? L3ConversationAssistantDetailSchema.safeParse(snapshot.detail)
          : null
      return {
        summary: {
          type: 'assistant',
          text: summary.text,
          model: 'model' in summary ? summary.model : null,
          errorMessage: summary.errorMessage,
          status: snapshot.fixed.status,
          usage: snapshot.fixed.usage,
          hasDetail: snapshot.fixed.hasDetail
        },
        detail: detail?.success ? { type: 'assistant', ...detail.data } : undefined
      }
    }
    case 'tool': {
      const fallback = {
        name: snapshot.fixed.viewKey,
        reasoning: null,
        inputPreview: null,
        activity: null
      }
      const fixed = {
        status: snapshot.fixed.status,
        usage: snapshot.fixed.usage,
        hasDetail: snapshot.fixed.hasDetail
      }
      switch (snapshot.fixed.viewKey) {
        case 'pi-desk/codemode': {
          const parsed = L3ConversationCodemodeSummarySchema.safeParse(snapshot.summary)
          const summary = parsed.success ? parsed.data : fallback
          const detail = L3ConversationCodemodeDetailSchema.safeParse(snapshot.detail)
          return {
            summary: { type: 'tool', kind: 'codemode', ...summary, ...fixed },
            detail: detail.success ? { type: 'tool', kind: 'codemode', ...detail.data } : undefined
          }
        }
        case 'pi-desk/pidesk': {
          const parsed = L3ConversationPiDeskSummarySchema.safeParse(snapshot.summary)
          const summary = parsed.success ? parsed.data : { input: {} }
          const detail = L3ConversationPiDeskDetailSchema.safeParse(snapshot.detail)
          return {
            summary: { type: 'tool', kind: 'pidesk', ...fallback, ...summary, ...fixed },
            detail: detail.success
              ? { type: 'tool', kind: 'pidesk', output: detail.data.output }
              : undefined
          }
        }
        case 'pi-desk/bash-tool': {
          const parsed = L3ConversationBashToolSummarySchema.safeParse(snapshot.summary)
          const summary = parsed.success ? parsed.data : { ...fallback, timing: null }
          const detail = L3ConversationGenericToolDetailSchema.safeParse(snapshot.detail)
          return {
            summary: { type: 'tool', kind: 'bash', ...summary, ...fixed },
            detail: detail.success
              ? { type: 'tool', kind: 'bash', output: detail.data.output }
              : undefined
          }
        }
        case 'pi-desk/read': {
          const parsed = L3ConversationReadSummarySchema.safeParse(snapshot.summary)
          const summary = parsed.success ? parsed.data : { ...fallback, path: null }
          const detail = L3ConversationReadDetailSchema.safeParse(snapshot.detail)
          return {
            summary: { type: 'tool', kind: 'read', ...summary, ...fixed },
            detail: detail.success
              ? { type: 'tool', kind: 'read', content: detail.data.content }
              : undefined
          }
        }
        case 'pi-desk/edit': {
          const parsed = L3ConversationEditSummarySchema.safeParse(snapshot.summary)
          const summary = parsed.success ? parsed.data : { ...fallback, path: null }
          const detail = L3ConversationEditDetailSchema.safeParse(snapshot.detail)
          return {
            summary: { type: 'tool', kind: 'edit', ...summary, ...fixed },
            detail: detail.success
              ? {
                  type: 'tool',
                  kind: 'edit',
                  contentKind: detail.data.kind,
                  content: detail.data.content
                }
              : undefined
          }
        }
        case 'pi-desk/write': {
          const parsed = L3ConversationWriteSummarySchema.safeParse(snapshot.summary)
          const summary = parsed.success ? parsed.data : { ...fallback, path: null }
          const detail = L3ConversationWriteDetailSchema.safeParse(snapshot.detail)
          return {
            summary: { type: 'tool', kind: 'write', ...summary, ...fixed },
            detail: detail.success
              ? {
                  type: 'tool',
                  kind: 'write',
                  contentKind: detail.data.kind,
                  content: detail.data.content
                }
              : undefined
          }
        }
        default: {
          const parsed = L3ConversationGenericToolSummarySchema.safeParse(snapshot.summary)
          const summary = parsed.success ? parsed.data : fallback
          const detail = L3ConversationGenericToolDetailSchema.safeParse(snapshot.detail)
          return {
            summary: { type: 'tool', kind: 'generic', ...summary, ...fixed },
            detail: detail.success
              ? { type: 'tool', kind: 'generic', output: detail.data.output }
              : undefined
          }
        }
      }
    }
    case 'bash': {
      const parsed = L3ConversationBashSummarySchema.safeParse(snapshot.summary)
      const summary = parsed.success ? parsed.data : { command: snapshot.fixed.viewKey }
      const detail = L3ConversationBashDetailSchema.safeParse(snapshot.detail)
      return {
        summary: {
          type: 'bash',
          command: summary.command,
          status: snapshot.fixed.status,
          hasDetail: snapshot.fixed.hasDetail
        },
        detail: detail.success ? { type: 'bash', ...detail.data } : undefined
      }
    }
    case 'custom': {
      if (snapshot.fixed.viewKey === 'pi-desk/compaction') {
        const detail = L3ConversationCompactionDetailSchema.safeParse(snapshot.detail)
        return {
          summary: { type: 'compaction', hasDetail: snapshot.fixed.hasDetail },
          detail: detail.success ? { type: 'compaction', ...detail.data } : undefined
        }
      }
      const parsed = L3ConversationCustomSummarySchema.safeParse(snapshot.summary)
      const summary = parsed.success ? parsed.data : { text: '' }
      return {
        summary: { type: 'custom', text: summary.text, hasDetail: false },
        detail: undefined
      }
    }
  }
}

function temporaryDisplayMessage(
  message: L3ConversationTemporaryMessageSnapshot,
  position: number
): L3ConversationDisplayMessage {
  const cached = temporaryDisplayMessageCache.get(message)
  if (cached?.position === position) return cached.message

  const layers = displayLayers(message)
  const displayMessage: L3ConversationDisplayMessage = {
    identity: `position:${position}`,
    position,
    viewKey: message.fixed.viewKey,
    snapshot: message,
    ...layers,
    temporary: true,
    timestampMs: message.fixed.timestampMs,
    durable: null,
    tempId: message.location.tempId
  }
  temporaryDisplayMessageCache.set(message, { position, message: displayMessage })
  return displayMessage
}

function durableDisplayMessage(
  message: L3ConversationDurableMessageSnapshot
): L3ConversationDisplayMessage {
  const cached = durableDisplayMessageCache.get(message)
  if (cached) return cached

  const layers = displayLayers(message)
  const displayMessage: L3ConversationDisplayMessage = {
    identity: `position:${message.location.index}`,
    position: message.location.index,
    viewKey: message.fixed.viewKey,
    snapshot: message,
    ...layers,
    temporary: false,
    timestampMs: message.fixed.timestampMs,
    durable: message,
    tempId: null
  }
  durableDisplayMessageCache.set(message, displayMessage)
  return displayMessage
}

function isRunning(message: L3ConversationDisplayMessage): boolean {
  return message.temporary || ('status' in message.summary && message.summary.status === 'running')
}

function hasAssistantProcessDetail(message: L3ConversationDisplayMessage): boolean {
  if (message.summary.type !== 'assistant') return false
  if (message.summary.status === 'error' || message.summary.errorMessage) return true
  if (message.detail?.type === 'assistant') return message.detail.thinking.trim().length > 0
  return message.summary.hasDetail
}

function hasProcessContent(message: L3ConversationDisplayMessage): boolean {
  if (message.summary.type !== 'assistant') return true
  if (message.viewKey !== 'pi-desk/assistant') return true
  return message.summary.text.trim().length > 0 || hasAssistantProcessDetail(message)
}

function finalAssistantIndex(messages: readonly L3ConversationDisplayMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!
    if (message.summary.type === 'custom') continue
    if (message.summary.type !== 'assistant') return -1
    return message.summary.text.trim() || message.viewKey !== 'pi-desk/assistant' ? index : -1
  }
  return -1
}

function buildTurn(
  identity: string,
  user: L3ConversationDisplayMessage | null,
  messages: readonly L3ConversationDisplayMessage[]
): L3ConversationTurn {
  const answerIndex = finalAssistantIndex(messages)
  const finalAssistant = answerIndex >= 0 ? messages[answerIndex]! : null
  const processItems: L3ConversationProcessItem[] = []

  for (const [index, message] of messages.entries()) {
    if (index !== answerIndex) {
      if (hasProcessContent(message)) {
        processItems.push({ message, hideAssistantText: false })
      }
      continue
    }
    if (hasAssistantProcessDetail(message)) {
      processItems.push({ message, hideAssistantText: true })
    }
  }

  return {
    identity,
    user,
    processItems,
    finalAssistant,
    compaction: null,
    running: messages.some(isRunning),
    toolCount: messages.filter(
      (message) => message.summary.type === 'tool' || message.summary.type === 'bash'
    ).length
  }
}

function appendTurnMessage(
  turns: L3ConversationTurn[],
  current: {
    user: L3ConversationDisplayMessage | null
    body: L3ConversationDisplayMessage[]
  },
  message: L3ConversationDisplayMessage
): void {
  if (message.summary.type === 'compaction') {
    commitTurn(turns, current)
    turns.push({
      identity: message.identity,
      user: null,
      processItems: [],
      finalAssistant: null,
      compaction: message,
      running: isRunning(message),
      toolCount: 0
    })
    return
  }
  if (message.summary.type !== 'user') {
    current.body.push(message)
    return
  }

  commitTurn(turns, current)
  current.user = message
}

function commitTurn(
  turns: L3ConversationTurn[],
  current: {
    user: L3ConversationDisplayMessage | null
    body: L3ConversationDisplayMessage[]
  }
): void {
  if (!current.user && current.body.length === 0) return
  const identity = current.user?.identity ?? current.body[0]!.identity
  turns.push(buildTurn(identity, current.user, current.body))
  current.user = null
  current.body = []
}

function durableTurnPrefix(
  messages: readonly L3ConversationDurableMessageSnapshot[]
): L3ConversationDurableTurnPrefix {
  const cached = durableTurnPrefixCache.get(messages)
  if (cached) return cached

  const turns: L3ConversationTurn[] = []
  const current: {
    user: L3ConversationDisplayMessage | null
    body: L3ConversationDisplayMessage[]
  } = { user: null, body: [] }
  const seen = new Set<string>()
  let calls: L3ConversationDisplayMessage[] = []
  let incomplete = (messages[0]?.location.index ?? 0) > 0
  for (const snapshot of messages) {
    if (seen.has(snapshot.location.entryId)) continue
    seen.add(snapshot.location.entryId)
    let message = durableDisplayMessage(snapshot)
    if (message.summary.type === 'compaction') {
      calls = []
      incomplete = false
    } else if (snapshot.fixed.type === 'assistant') {
      calls.push(message)
      // 文字回复的原用量位置形成边界，不能按用户轮次或折叠后的 DOM 计数。
      if (
        message.summary.type === 'assistant' &&
        message.timestampMs !== null &&
        (message.summary.text.trim() || message.viewKey !== 'pi-desk/assistant')
      ) {
        message = { ...message, usageCalls: calls, usageIncomplete: incomplete }
        calls = []
        incomplete = false
      }
    }
    appendTurnMessage(turns, current, message)
  }

  const prefix: L3ConversationDurableTurnPrefix = {
    turns,
    user: current.user,
    body: current.body
  }
  durableTurnPrefixCache.set(messages, prefix)
  return prefix
}

export function buildL3ConversationTurns(
  state: L3ConversationState,
  latestTurnRunning = false
): L3ConversationTurn[] {
  const prefix = durableTurnPrefix(state.messages)
  const turns = [...prefix.turns]
  const current: {
    user: L3ConversationDisplayMessage | null
    body: L3ConversationDisplayMessage[]
  } = { user: prefix.user, body: [...prefix.body] }

  for (const [index, message] of state.temporaryMessages.entries()) {
    appendTurnMessage(
      turns,
      current,
      temporaryDisplayMessage(message, state.messages.length + index)
    )
  }
  commitTurn(turns, current)
  const latestTurn = turns.at(-1)
  if (latestTurnRunning && latestTurn && !latestTurn.compaction) latestTurn.running = true
  return turns
}

export function formatL3ConversationTokenCount(tokens: number): string {
  if (tokens < 1_000) return String(tokens)
  if (tokens < 1_000_000) {
    return `${(tokens / 1_000).toFixed(1).replace(/\.0$/, '')}k`
  }
  return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, '')}m`
}

export function formatL3ConversationCost(costUsd: number): string {
  if (costUsd === 0) return '$0'
  if (costUsd < 0.0001) return '<$0.0001'
  return `$${costUsd.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')}`
}

export function formatL3ConversationTimestamp(
  timestampMs: number,
  nowMs: number = Date.now(),
  locale = 'en',
  timeZone = 'UTC'
): { compact: string; full: string } {
  const timestamp = new Date(timestampMs)
  const today = new Date(nowMs)
  const formatters = timeFormatters(locale, timeZone)
  return {
    compact:
      formatters.dateKey.format(timestamp) === formatters.dateKey.format(today)
        ? formatters.compactTime.format(timestamp)
        : formatters.compactDateTime.format(timestamp),
    full: formatters.fullDateTime.format(timestamp)
  }
}
