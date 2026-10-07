import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { CONTEXT_IGNORE_ENTRY_TYPE, DEFAULT_KEEP_TURNS, type ContextIgnoreState } from './types.js'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function parseState(value: unknown): ContextIgnoreState | undefined {
  if (!isRecord(value)) return undefined
  if (typeof value.enabled !== 'boolean') return undefined
  if (typeof value.keepTurns !== 'number') return undefined
  if (typeof value.updatedAt !== 'number') return undefined
  if (
    value.mode !== undefined &&
    value.mode !== 'user-turns' &&
    value.mode !== 'internal-turns' &&
    value.mode !== 'combined'
  ) {
    return undefined
  }
  if (value.cutoffTimestamp !== undefined && typeof value.cutoffTimestamp !== 'number') {
    return undefined
  }
  if (
    value.internalTurnCutoffs !== undefined &&
    (!Array.isArray(value.internalTurnCutoffs) ||
      value.internalTurnCutoffs.some(
        (cutoff) =>
          !isRecord(cutoff) ||
          typeof cutoff.cutoffTimestamp !== 'number' ||
          (cutoff.userTimestamp !== undefined && typeof cutoff.userTimestamp !== 'number')
      ))
  ) {
    return undefined
  }
  if (
    value.internalTurnCutoffTimestamp !== undefined &&
    typeof value.internalTurnCutoffTimestamp !== 'number'
  ) {
    return undefined
  }
  if (
    value.internalTurnUserTimestamp !== undefined &&
    typeof value.internalTurnUserTimestamp !== 'number'
  ) {
    return undefined
  }
  if (
    value.pendingUsageRefreshAfterTimestamp !== undefined &&
    typeof value.pendingUsageRefreshAfterTimestamp !== 'number'
  ) {
    return undefined
  }
  if (
    value.estimatedContextTokens !== undefined &&
    typeof value.estimatedContextTokens !== 'number'
  ) {
    return undefined
  }
  if (
    value.skillBaseDirs !== undefined &&
    (!Array.isArray(value.skillBaseDirs) ||
      value.skillBaseDirs.some((path) => typeof path !== 'string'))
  ) {
    return undefined
  }
  if (
    value.skillFilePaths !== undefined &&
    (!Array.isArray(value.skillFilePaths) ||
      value.skillFilePaths.some((path) => typeof path !== 'string'))
  ) {
    return undefined
  }
  if (value.keepInternalTurns !== undefined && typeof value.keepInternalTurns !== 'number') {
    return undefined
  }

  const legacyInternalCutoff =
    value.internalTurnCutoffTimestamp ??
    (value.mode === 'internal-turns' ? value.cutoffTimestamp : undefined)
  const internalTurnCutoffs =
    value.internalTurnCutoffs ??
    (legacyInternalCutoff === undefined
      ? undefined
      : [{ cutoffTimestamp: legacyInternalCutoff, userTimestamp: value.internalTurnUserTimestamp }])

  return {
    enabled: value.enabled,
    mode: value.mode ?? 'user-turns',
    cutoffTimestamp: value.mode === 'internal-turns' ? undefined : value.cutoffTimestamp,
    internalTurnCutoffs,
    pendingUsageRefreshAfterTimestamp: value.pendingUsageRefreshAfterTimestamp,
    estimatedContextTokens:
      value.estimatedContextTokens === undefined
        ? undefined
        : Math.max(0, value.estimatedContextTokens),
    skillBaseDirs: value.skillBaseDirs,
    skillFilePaths: value.skillFilePaths,
    keepTurns: Math.max(1, Math.floor(value.keepTurns)),
    updatedAt: value.updatedAt
  }
}

export function defaultContextIgnoreState(): ContextIgnoreState {
  return {
    enabled: false,
    mode: 'user-turns',
    keepTurns: DEFAULT_KEEP_TURNS,
    updatedAt: Date.now()
  }
}

export function loadContextIgnoreState(
  sessionManager: ExtensionContext['sessionManager']
): ContextIgnoreState {
  const state = defaultContextIgnoreState()
  const branch = sessionManager.getBranch()

  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index]!
    if (entry.type !== 'custom' || entry.customType !== CONTEXT_IGNORE_ENTRY_TYPE) {
      continue
    }
    const parsed = parseState(entry.data)
    if (parsed) return parsed
  }

  return state
}

export function persistContextIgnoreState(pi: ExtensionAPI, state: ContextIgnoreState) {
  pi.appendEntry(CONTEXT_IGNORE_ENTRY_TYPE, state)
}
