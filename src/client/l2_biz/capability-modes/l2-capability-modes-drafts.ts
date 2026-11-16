import type { L2CapabilityModesReplaceRequest } from '@common/l2_biz/capability-modes/l2-capability-modes-contract'
import type { L3CapabilityModes } from '@common/l3_modules/capability-modes/l3-capability-modes-contract'

export type L2CapabilitySelection =
  { kind: 'global' } | { kind: 'all' } | { kind: 'mode'; key: string }

export interface L2PromptDraft {
  saved: string | null
  content: string
}

export interface L2CapabilityDrafts {
  saved: L3CapabilityModes | null
  modes: L3CapabilityModes
  global: L2PromptDraft | null
  prompts: Record<string, L2PromptDraft>
}

export function l2EmptyCapabilityDrafts(): L2CapabilityDrafts {
  return { saved: null, modes: {}, global: null, prompts: {} }
}

export function l2InitializeCapabilityDrafts(
  state: L2CapabilityDrafts,
  modes: L3CapabilityModes
): L2CapabilityDrafts {
  return state.saved === null ? { ...state, saved: modes, modes: structuredClone(modes) } : state
}

export function l2PromptDirty(prompt: L2PromptDraft | null | undefined): boolean {
  return prompt !== null && prompt !== undefined && prompt.content !== prompt.saved
}

export function l2CapabilityModeDirty(state: L2CapabilityDrafts, key: string): boolean {
  return (
    JSON.stringify(state.modes[key]) !== JSON.stringify(state.saved?.[key]) ||
    l2PromptDirty(state.prompts[key])
  )
}

export function l2DirtyCapabilityItems(state: L2CapabilityDrafts): L2CapabilitySelection[] {
  return [
    ...(l2PromptDirty(state.global) ? [{ kind: 'global' } as const] : []),
    ...Object.keys(state.modes)
      .filter((key) => l2CapabilityModeDirty(state, key))
      .map((key) => ({ kind: 'mode' as const, key }))
  ]
}

export function l2AddCapabilityDraft(
  state: L2CapabilityDrafts,
  key: string,
  name: string,
  sourceKey?: string,
  copiedContent?: string
): L2CapabilityDrafts {
  const source = sourceKey === undefined ? undefined : state.modes[sourceKey]
  return {
    ...state,
    modes: { ...state.modes, [key]: { ...(source ? structuredClone(source) : {}), name } },
    prompts: {
      ...state.prompts,
      [key]: { saved: copiedContent === undefined ? '' : null, content: copiedContent ?? '' }
    }
  }
}

export function l2CapabilityModeSubmission(
  state: L2CapabilityDrafts,
  key: string
): L2CapabilityModesReplaceRequest {
  const prompt = state.prompts[key]
  return {
    modes: { ...state.saved, [key]: state.modes[key]! },
    ...(l2PromptDirty(prompt) ? { promptContents: { [key]: prompt!.content } } : {})
  }
}

export function l2AcceptCapabilitySave(
  state: L2CapabilityDrafts,
  key: string,
  request: L2CapabilityModesReplaceRequest
): L2CapabilityDrafts {
  const content = request.promptContents?.[key]
  return {
    ...state,
    saved: request.modes,
    modes: { ...state.modes, [key]: request.modes[key]! },
    prompts:
      content === undefined
        ? state.prompts
        : { ...state.prompts, [key]: { saved: content, content } }
  }
}

export function l2ForgetCapabilityMode(state: L2CapabilityDrafts, key: string): L2CapabilityDrafts {
  const saved = { ...state.saved }
  const modes = { ...state.modes }
  const prompts = { ...state.prompts }
  delete saved[key]
  delete modes[key]
  delete prompts[key]
  return { ...state, saved, modes, prompts }
}

export function l2DiscardCapabilityItem(
  state: L2CapabilityDrafts,
  item: L2CapabilitySelection
): L2CapabilityDrafts {
  if (item.kind === 'all') return state
  if (item.kind === 'global') {
    return {
      ...state,
      global:
        state.global?.saved === null
          ? null
          : state.global
            ? { saved: state.global.saved, content: state.global.saved }
            : null
    }
  }
  if (!state.saved?.[item.key]) return l2ForgetCapabilityMode(state, item.key)
  const prompt = state.prompts[item.key]
  const prompts = { ...state.prompts }
  if (prompt?.saved === null) delete prompts[item.key]
  else if (prompt) prompts[item.key] = { saved: prompt.saved, content: prompt.saved }
  return {
    ...state,
    modes: { ...state.modes, [item.key]: structuredClone(state.saved[item.key]) },
    prompts
  }
}
