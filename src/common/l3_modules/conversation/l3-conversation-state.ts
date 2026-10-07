import {
  L3ConversationDurableMessageSnapshotSchema,
  L3ConversationMessageDetailObjectSchema,
  L3ConversationMessageSummarySchema,
  L3ConversationTemporaryMessageFixedSchema,
  L3ConversationTemporaryMessageSnapshotSchema,
  type L3ConversationDurableMessageSnapshot,
  type L3ConversationMessageDetailResponse,
  type L3ConversationMessageDetailObject,
  type L3ConversationMessageFixedPatch,
  type L3ConversationMessageSummary,
  type L3ConversationMessageSummaryPatch,
  type L3ConversationState,
  type L3ConversationTemporaryMessageSnapshot
} from './l3-conversation-contract'
import type {
  L3ConversationDurableAppendEvent,
  L3ConversationEvent,
  L3ConversationMessageUpdateEvent,
  L3ConversationRealtimeEvent
} from './l3-conversation-event-contract'
import {
  parseL3ConversationIncrementPath,
  type L3ConversationIncrementSegment
} from './l3-conversation-increment-path'

function durableIdentity(message: L3ConversationDurableMessageSnapshot): string {
  return `${message.location.index}:${message.location.entryId}`
}

function assertAllowedPatchKeys(patch: object, allowed: readonly string[], layer: string): void {
  const unexpected = Object.keys(patch).filter((key) => !allowed.includes(key))
  if (unexpected.length > 0) {
    throw new Error(`${layer} patch contains fields invalid for the current message: ${unexpected}`)
  }
}

const FIXED_PATCH_KEYS: Record<
  L3ConversationTemporaryMessageSnapshot['fixed']['type'],
  readonly string[]
> = {
  user: ['viewKey', 'hasDetail'],
  assistant: ['viewKey', 'status', 'hasDetail', 'usage'],
  tool: ['viewKey', 'status', 'hasDetail', 'usage'],
  bash: ['viewKey', 'status', 'hasDetail'],
  custom: ['viewKey', 'hasDetail']
}

function applyFixedPatch(
  current: L3ConversationTemporaryMessageSnapshot['fixed'],
  patch: L3ConversationMessageFixedPatch | undefined
): L3ConversationTemporaryMessageSnapshot['fixed'] {
  if (!patch) return current
  assertAllowedPatchKeys(patch, FIXED_PATCH_KEYS[current.type], `${current.type} fixed`)
  return L3ConversationTemporaryMessageFixedSchema.parse({ ...current, ...patch })
}

function applyTopLevelPatch(
  current: L3ConversationMessageSummary,
  patch: L3ConversationMessageSummaryPatch | undefined,
  layer: 'summary' | 'detail'
): L3ConversationMessageSummary {
  if (!patch) return current
  const next = { ...current, ...patch }
  return layer === 'summary'
    ? L3ConversationMessageSummarySchema.parse(next)
    : L3ConversationMessageDetailObjectSchema.parse(next)
}

function readPathTarget(
  root: unknown,
  segments: readonly L3ConversationIncrementSegment[]
): { parent: Record<string, unknown> | unknown[]; key: string | number; value: unknown } {
  if (segments.length === 0) throw new Error('Increment cannot append to the message layer root')
  let current: unknown = root

  for (const segment of segments.slice(0, -1)) {
    if (typeof segment === 'number') {
      if (!Array.isArray(current) || segment >= current.length) {
        throw new Error(`Increment array path does not exist: ${segment}`)
      }
      current = current[segment]
      continue
    }
    if (!current || typeof current !== 'object' || Array.isArray(current)) {
      throw new Error(`Increment object path does not exist: ${segment}`)
    }
    if (!Object.hasOwn(current, segment)) {
      throw new Error(`Increment object field does not exist: ${segment}`)
    }
    current = (current as Record<string, unknown>)[segment]
  }

  const key = segments.at(-1)!
  if (typeof key === 'number') {
    if (!Array.isArray(current) || key >= current.length) {
      throw new Error(`Increment array target does not exist: ${key}`)
    }
    return { parent: current, key, value: current[key] }
  }
  if (!current || typeof current !== 'object' || Array.isArray(current)) {
    throw new Error(`Increment object target does not exist: ${key}`)
  }
  if (!Object.hasOwn(current, key)) throw new Error(`Increment target does not exist: ${key}`)
  return {
    parent: current as Record<string, unknown>,
    key,
    value: (current as Record<string, unknown>)[key]
  }
}

function setPathTarget(
  target: { parent: Record<string, unknown> | unknown[]; key: string | number },
  value: unknown
): void {
  if (Array.isArray(target.parent)) {
    if (typeof target.key !== 'number') throw new Error('Increment array key is invalid')
    target.parent[target.key] = value
    return
  }
  if (typeof target.key !== 'string') throw new Error('Increment object key is invalid')
  target.parent[target.key] = value
}

function appendIncrement(
  root: L3ConversationMessageSummary,
  segments: readonly L3ConversationIncrementSegment[],
  increment: string | unknown[]
): L3ConversationMessageSummary {
  const next = structuredClone(root)
  const target = readPathTarget(next, segments)
  if (typeof increment === 'string') {
    if (typeof target.value !== 'string') throw new Error('Increment target is not a string')
    setPathTarget(target, `${target.value}${increment}`)
    return L3ConversationMessageSummarySchema.parse(next)
  }
  if (!Array.isArray(target.value)) throw new Error('Increment target is not an array')
  setPathTarget(target, [...target.value, ...increment])
  return L3ConversationMessageSummarySchema.parse(next)
}

export function applyL3ConversationMessageUpdate(
  current: L3ConversationTemporaryMessageSnapshot,
  event: L3ConversationMessageUpdateEvent
): L3ConversationTemporaryMessageSnapshot {
  if (current.location.tempId !== event.location.tempId) {
    throw new Error(`Conversation update tempId mismatch: ${event.location.tempId}`)
  }

  let fixed = applyFixedPatch(current.fixed, event.fixed)
  let summary = applyTopLevelPatch(current.summary, event.summary, 'summary')
  let detail: L3ConversationMessageDetailObject | undefined = current.detail
  const hasDetailUpdate =
    event.detail !== undefined ||
    Object.keys(event.increments ?? {}).some(
      (path) => parseL3ConversationIncrementPath(path).root === 'detail'
    )
  if (hasDetailUpdate) {
    if (event.fixed?.hasDetail === false) {
      throw new Error('Realtime detail cannot be updated while explicitly clearing hasDetail')
    }
    if (!fixed.hasDetail) {
      fixed = L3ConversationTemporaryMessageFixedSchema.parse({ ...fixed, hasDetail: true })
    }
  }

  if (event.detail) {
    detail = applyTopLevelPatch(detail ?? {}, event.detail, 'detail')
  }

  for (const [rawPath, increment] of Object.entries(event.increments ?? {})) {
    const path = parseL3ConversationIncrementPath(rawPath)
    if (path.root === 'summary') {
      summary = appendIncrement(summary, path.segments, increment)
    } else {
      detail = appendIncrement(detail ?? {}, path.segments, increment)
    }
  }

  if (!fixed.hasDetail) detail = undefined

  return L3ConversationTemporaryMessageSnapshotSchema.parse({
    location: current.location,
    fixed,
    summary,
    ...(detail === undefined ? {} : { detail })
  })
}

export function replaceL3ConversationSnapshot(
  current: L3ConversationState,
  messagesInput: readonly L3ConversationDurableMessageSnapshot[],
  temporaryMessages: readonly L3ConversationTemporaryMessageSnapshot[]
): L3ConversationState {
  const existingMessages = new Map(
    current.messages
      .filter((message) => message.detail !== undefined)
      .map((message) => [durableIdentity(message), message] as const)
  )
  const messages = messagesInput.map((message) => {
    const existing = existingMessages.get(durableIdentity(message))
    if (
      !message.fixed.hasDetail ||
      !existing ||
      existing.fixed.type !== message.fixed.type ||
      existing.fixed.viewKey !== message.fixed.viewKey ||
      existing.detail === undefined
    ) {
      return message
    }
    return L3ConversationDurableMessageSnapshotSchema.parse({
      ...message,
      detail: existing.detail
    })
  })
  return { messages, temporaryMessages: [...temporaryMessages] }
}

export function appendL3ConversationDurableMessages(
  current: L3ConversationState,
  event: L3ConversationDurableAppendEvent
): L3ConversationState {
  const expectedIndex = current.messages.length
  if (event.messages[0]?.location.index !== expectedIndex) {
    throw new Error(
      `Conversation append index is not continuous: expected ${expectedIndex}, received ${event.messages[0]?.location.index}`
    )
  }
  const knownEntryIds = new Set(current.messages.map((message) => message.location.entryId))
  for (const message of event.messages) {
    if (knownEntryIds.has(message.location.entryId)) {
      throw new Error(`Conversation append entryId already exists: ${message.location.entryId}`)
    }
    knownEntryIds.add(message.location.entryId)
  }
  return { ...current, messages: [...current.messages, ...event.messages] }
}

export function applyL3ConversationRealtimeEvent(
  current: L3ConversationState,
  event: L3ConversationRealtimeEvent
): L3ConversationState {
  if (event.type === 'message_start') {
    if (
      current.temporaryMessages.some(
        (message) => message.location.tempId === event.snapshot.location.tempId
      )
    ) {
      throw new Error(
        `Temporary conversation message already exists: ${event.snapshot.location.tempId}`
      )
    }
    return {
      ...current,
      temporaryMessages: [...current.temporaryMessages, event.snapshot]
    }
  }

  const temporaryIndex = current.temporaryMessages.findIndex(
    (message) => message.location.tempId === event.location.tempId
  )
  if (temporaryIndex < 0) {
    throw new Error(`Temporary conversation message was not found: ${event.location.tempId}`)
  }

  if (event.type === 'message_update') {
    const temporaryMessages = [...current.temporaryMessages]
    temporaryMessages[temporaryIndex] = applyL3ConversationMessageUpdate(
      temporaryMessages[temporaryIndex]!,
      event
    )
    return { ...current, temporaryMessages }
  }

  if (event.type === 'message_discard') {
    return {
      ...current,
      temporaryMessages: current.temporaryMessages.filter(
        (message) => message.location.tempId !== event.location.tempId
      )
    }
  }

  if (event.durable.index !== current.messages.length) {
    throw new Error(
      `Conversation commit index is not continuous: expected ${current.messages.length}, received ${event.durable.index}`
    )
  }
  if (current.messages.some((message) => message.location.entryId === event.durable.entryId)) {
    throw new Error(`Conversation commit entryId already exists: ${event.durable.entryId}`)
  }

  const temporary = current.temporaryMessages[temporaryIndex]!
  const { detail, fixed, ...layers } = temporary
  const durable = L3ConversationDurableMessageSnapshotSchema.parse({
    ...layers,
    location: event.durable,
    fixed: { ...fixed, timestampMs: event.fixed.timestampMs },
    ...(fixed.hasDetail && detail !== undefined ? { detail } : {})
  })
  return {
    messages: [...current.messages, durable],
    temporaryMessages: current.temporaryMessages.filter(
      (message) => message.location.tempId !== event.location.tempId
    )
  }
}

export function applyL3ConversationEvent(
  current: L3ConversationState,
  event: L3ConversationEvent
): L3ConversationState {
  return event.type === 'durable_append'
    ? appendL3ConversationDurableMessages(current, event)
    : applyL3ConversationRealtimeEvent(current, event)
}

export function applyL3ConversationMessageDetail(
  current: L3ConversationState,
  response: L3ConversationMessageDetailResponse
): L3ConversationState {
  const index = current.messages.findIndex(
    (message) =>
      message.location.index === response.index && message.location.entryId === response.entryId
  )
  if (index < 0) {
    throw new Error(
      `Conversation detail target was not found: ${response.index}/${response.entryId}`
    )
  }

  const message = current.messages[index]!
  if (response.detail !== null && !message.fixed.hasDetail) {
    throw new Error('Message without hasDetail cannot accept detail')
  }

  const messages = [...current.messages]
  messages[index] = L3ConversationDurableMessageSnapshotSchema.parse({
    ...message,
    ...(response.detail === null ? { detail: undefined } : { detail: response.detail })
  })
  return { ...current, messages }
}
