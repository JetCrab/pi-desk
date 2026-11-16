import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  L3CapabilityCatalog,
  L3CapabilityMode
} from '@common/l3_modules/capability-modes/l3-capability-modes-contract'
import type { L2CapabilityModesBiz } from '../l2-capability-modes-biz'
import { l2NewCapabilityModeName } from '../l2-capability-modes-model'
import {
  l2AcceptCapabilitySave,
  l2AddCapabilityDraft,
  l2CapabilityModeSubmission,
  l2DirtyCapabilityItems,
  l2DiscardCapabilityItem,
  l2EmptyCapabilityDrafts,
  l2ForgetCapabilityMode,
  l2InitializeCapabilityDrafts,
  type L2CapabilityDrafts,
  type L2CapabilitySelection
} from '../l2-capability-modes-drafts'

interface L2CapabilityModesEditor {
  drafts: L2CapabilityDrafts
  catalog: L3CapabilityCatalog | null
  selected: L2CapabilitySelection
  loading: boolean
  saving: boolean
  copying: boolean
  error: string | null
  promptErrors: Record<string, string | undefined>
  leaveOpen: boolean
  dirtyItems: L2CapabilitySelection[]
  load(refresh?: boolean): Promise<boolean>
  ensurePrompt(key?: string): Promise<string | null>
  select(item: L2CapabilitySelection): Promise<boolean>
  add(copy?: boolean): Promise<boolean>
  update(mode: L3CapabilityMode): void
  updatePrompt(content: string): void
  resetPrompt(): void
  remove(): Promise<boolean>
  save(): Promise<boolean>
  discard(): void
  beforeLeave(): Promise<boolean>
  decideLeave(choice: 'save' | 'discard' | 'cancel'): Promise<void>
}

export function useL2CapabilityModes(biz: L2CapabilityModesBiz): L2CapabilityModesEditor {
  const { t } = useTranslation('capabilityModes')
  const [drafts, setDrafts] = useState(l2EmptyCapabilityDrafts)
  const current = useRef(drafts)
  const [catalog, setCatalog] = useState<L3CapabilityCatalog | null>(null)
  const [selected, setSelected] = useState<L2CapabilitySelection>({ kind: 'global' })
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [copying, setCopying] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [promptErrors, setPromptErrors] = useState<Record<string, string | undefined>>({})
  const [leaveOpen, setLeaveOpen] = useState(false)
  const leaveResolve = useRef<((leave: boolean) => void) | null>(null)
  const controller = useRef<AbortController | null>(null)
  const pendingPrompts = useRef(new Map<string, Promise<string | null>>())
  const pendingModes = useRef<Promise<boolean> | null>(null)
  const selectionRequest = useRef(0)
  const change = useCallback((update: (state: L2CapabilityDrafts) => L2CapabilityDrafts): void => {
    current.current = update(current.current)
    setDrafts(current.current)
  }, [])

  const load = useCallback(
    (refresh = false): Promise<boolean> => {
      if (!refresh && current.current.saved !== null) return Promise.resolve(true)
      if (pendingModes.current) return pendingModes.current
      setLoading(true)
      setError(null)
      const signal = controller.current?.signal
      const task = Promise.resolve().then(async (): Promise<boolean> => {
        try {
          const result = await biz.get(signal)
          if (signal?.aborted) return false
          setCatalog(result.catalog)
          change((state) => l2InitializeCapabilityDrafts(state, result.modes))
          return true
        } catch (cause) {
          if (!signal?.aborted)
            setError(cause instanceof Error ? cause.message : t('catalogFailed'))
          return false
        } finally {
          if (!signal?.aborted) setLoading(false)
          if (pendingModes.current === task) pendingModes.current = null
        }
      })
      pendingModes.current = task
      return task
    },
    [biz, change, t]
  )

  const ensurePrompt = useCallback(
    (key?: string): Promise<string | null> => {
      const known = key === undefined ? current.current.global : current.current.prompts[key]
      if (known) return Promise.resolve(known.content)
      const id = key === undefined ? 'global' : `mode:${key}`
      const pending = pendingPrompts.current.get(id)
      if (pending) return pending
      setPromptErrors((errors) => ({ ...errors, [id]: undefined }))
      const signal = controller.current?.signal
      const task = Promise.resolve().then(async (): Promise<string | null> => {
        try {
          const content =
            key !== undefined && !current.current.saved?.[key]
              ? ''
              : await biz.getPrompt(key, signal)
          if (signal?.aborted) return null
          change((state) => {
            if (key === undefined)
              return state.global ? state : { ...state, global: { saved: content, content } }
            if (!state.modes[key] || state.prompts[key]) return state
            const explicitEmpty =
              content === '' &&
              state.modes[key]?.promptSource === 'custom' &&
              state.saved?.[key]?.promptSource !== 'custom'
            return {
              ...state,
              prompts: {
                ...state.prompts,
                [key]: { saved: explicitEmpty ? null : content, content }
              }
            }
          })
          return content
        } catch (cause) {
          if (!signal?.aborted)
            setPromptErrors((errors) => ({
              ...errors,
              [id]: cause instanceof Error ? cause.message : t('promptReadFailed')
            }))
          return null
        } finally {
          if (pendingPrompts.current.get(id) === task) pendingPrompts.current.delete(id)
        }
      })
      pendingPrompts.current.set(id, task)
      return task
    },
    [biz, change, t]
  )

  useEffect(() => {
    const active = new AbortController()
    controller.current = active
    const requests = pendingPrompts.current
    void ensurePrompt()
    return (): void => {
      active.abort()
      requests.clear()
      pendingModes.current = null
      selectionRequest.current += 1
      leaveResolve.current?.(false)
      leaveResolve.current = null
    }
  }, [ensurePrompt])

  const selectedKey = selected.kind === 'mode' ? selected.key : undefined
  const selectedSource = selectedKey
    ? (drafts.modes[selectedKey]?.promptSource ?? 'global')
    : 'global'
  const promptLoaded = selectedKey !== undefined && drafts.prompts[selectedKey] !== undefined
  const globalLoaded = drafts.global !== null
  useEffect(() => {
    if (!globalLoaded) void ensurePrompt()
    if (selectedKey !== undefined && selectedSource === 'custom' && !promptLoaded)
      void ensurePrompt(selectedKey)
  }, [ensurePrompt, globalLoaded, promptLoaded, selectedKey, selectedSource])

  const select = useCallback(
    async (item: L2CapabilitySelection): Promise<boolean> => {
      const request = ++selectionRequest.current
      if (item.kind === 'mode') {
        if (!(await load()) || request !== selectionRequest.current) return false
        if (!Object.hasOwn(current.current.modes, item.key)) {
          setError(t('modeUnavailable'))
          return false
        }
      }
      setSelected(item)
      return true
    },
    [load, t]
  )

  const update = useCallback(
    (mode: L3CapabilityMode): void => {
      if (selected.kind === 'mode')
        change((state) => {
          const prompt = state.prompts[selected.key]
          const explicitEmpty =
            mode.promptSource === 'custom' &&
            state.modes[selected.key]?.promptSource !== 'custom' &&
            prompt?.content === '' &&
            state.saved?.[selected.key]?.promptSource !== 'custom'
          return {
            ...state,
            modes: { ...state.modes, [selected.key]: mode },
            prompts: explicitEmpty
              ? { ...state.prompts, [selected.key]: { ...prompt, saved: null, content: '' } }
              : state.prompts
          }
        })
    },
    [change, selected]
  )

  const updatePrompt = useCallback(
    (content: string): void => {
      change((state) => {
        if (selected.kind === 'global' && state.global)
          return { ...state, global: { ...state.global, content } }
        if (selected.kind === 'mode' && state.prompts[selected.key])
          return {
            ...state,
            prompts: {
              ...state.prompts,
              [selected.key]: { ...state.prompts[selected.key]!, content }
            }
          }
        return state
      })
    },
    [change, selected]
  )

  const resetPrompt = useCallback((): void => {
    if (selected.kind === 'all') return
    const key = selected.kind === 'mode' ? selected.key : undefined
    const id = key === undefined ? 'global' : `mode:${key}`
    change((state) =>
      key === undefined
        ? { ...state, global: { saved: null, content: '' } }
        : { ...state, prompts: { ...state.prompts, [key]: { saved: null, content: '' } } }
    )
    setPromptErrors((errors) => ({ ...errors, [id]: undefined }))
  }, [change, selected])

  const add = useCallback(
    async (copy = false): Promise<boolean> => {
      setCopying(true)
      try {
        if (!(await load())) return false
        const sourceKey = copy && selected.kind === 'mode' ? selected.key : undefined
        const content = sourceKey === undefined ? '' : await ensurePrompt(sourceKey)
        if (content === null) {
          setError(t('copyPromptFailed'))
          return false
        }
        if (controller.current?.signal.aborted) return false
        const source = sourceKey === undefined ? undefined : current.current.modes[sourceKey]
        const key = crypto.randomUUID()
        const name = l2NewCapabilityModeName(
          current.current.modes,
          copy ? t('copySuffix', { name: source?.name || t('allEnabled') }) : t('newMode')
        )
        change((state) =>
          l2AddCapabilityDraft(state, key, name, sourceKey, copy ? content : undefined)
        )
        selectionRequest.current += 1
        setSelected({ kind: 'mode', key })
        return true
      } finally {
        setCopying(false)
      }
    },
    [change, ensurePrompt, load, selected, t]
  )

  const persist = useCallback(
    async (item: L2CapabilitySelection): Promise<string | null> => {
      try {
        if (item.kind === 'global') {
          const prompt = current.current.global
          if (!prompt) return t('promptReadFailed')
          await biz.replaceGlobalPrompt(prompt.content, controller.current?.signal)
          if (controller.current?.signal.aborted) return t('saveFailed')
          change((state) => ({
            ...state,
            global: { saved: prompt.content, content: prompt.content }
          }))
        } else if (item.kind === 'mode') {
          const request = l2CapabilityModeSubmission(current.current, item.key)
          const normalized = await biz.replace(request, controller.current?.signal)
          if (controller.current?.signal.aborted) return t('saveFailed')
          change((state) => l2AcceptCapabilitySave(state, item.key, normalized))
        }
        return null
      } catch (cause) {
        return cause instanceof Error ? cause.message : t('saveFailed')
      }
    },
    [biz, change, t]
  )

  const save = useCallback(async (): Promise<boolean> => {
    setSaving(true)
    setError(null)
    try {
      const failure = await persist(selected)
      setError(failure)
      return failure === null
    } finally {
      setSaving(false)
    }
  }, [persist, selected])

  const remove = useCallback(async (): Promise<boolean> => {
    if (selected.kind !== 'mode') return false
    setSaving(true)
    setError(null)
    try {
      if (current.current.saved?.[selected.key]) {
        const modes = { ...current.current.saved }
        delete modes[selected.key]
        await biz.replace({ modes }, controller.current?.signal)
        if (controller.current?.signal.aborted) return false
      }
      change((state) => l2ForgetCapabilityMode(state, selected.key))
      setSelected({ kind: 'all' })
      return true
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('saveFailed'))
      return false
    } finally {
      setSaving(false)
    }
  }, [biz, change, selected, t])

  const discard = useCallback((): void => {
    change((state) => l2DiscardCapabilityItem(state, selected))
    if (selected.kind === 'mode' && !current.current.modes[selected.key])
      setSelected({ kind: 'all' })
    setError(null)
  }, [change, selected])

  const beforeLeave = useCallback((): Promise<boolean> => {
    if (saving || copying) return Promise.resolve(false)
    if (l2DirtyCapabilityItems(current.current).length === 0) return Promise.resolve(true)
    if (leaveResolve.current) return Promise.resolve(false)
    setLeaveOpen(true)
    return new Promise<boolean>((resolve) => {
      leaveResolve.current = resolve
    })
  }, [copying, saving])

  const decideLeave = useCallback(
    async (choice: 'save' | 'discard' | 'cancel'): Promise<void> => {
      if (choice === 'save') {
        setSaving(true)
        const failures: string[] = []
        try {
          for (const item of l2DirtyCapabilityItems(current.current)) {
            const failure = await persist(item)
            if (failure)
              failures.push(
                `${item.kind === 'global' ? t('globalPrompt') : item.kind === 'mode' ? current.current.modes[item.key]?.name : ''}: ${failure}`
              )
          }
        } finally {
          setSaving(false)
        }
        setError(failures.length ? failures.join('\n') : null)
        if (failures.length) return
      } else if (choice === 'discard') {
        change((state) => l2DirtyCapabilityItems(state).reduce(l2DiscardCapabilityItem, state))
      }
      setLeaveOpen(false)
      leaveResolve.current?.(choice !== 'cancel')
      leaveResolve.current = null
    },
    [change, persist, t]
  )

  return {
    drafts,
    catalog,
    selected,
    loading,
    saving,
    copying,
    error,
    promptErrors,
    leaveOpen,
    dirtyItems: l2DirtyCapabilityItems(drafts),
    load,
    ensurePrompt,
    select,
    add,
    update,
    updatePrompt,
    resetPrompt,
    remove,
    save,
    discard,
    beforeLeave,
    decideLeave
  }
}
