import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { BrowserPluginHost, BrowserSettingsPageTarget } from '@jetcrab/pi-desk-sdk/browser'
import type { HostRegion } from '@jetcrab/pi-desk-sdk/settings'
import { tiboText } from './l4-tibo-locale.js'
import { TiboBrowserBiz } from './l2-tibo-browser-biz.js'
import {
  defaultSettings,
  errorText,
  settingsSchema,
  type TiboModelOption,
  type TiboRecord,
  type TiboSettings,
  type TiboSnapshot
} from './l4-tibo-protocol.js'

export function useTiboRegion(host: BrowserPluginHost): HostRegion {
  const subscribe = useCallback((listener: () => void) => host.settings.subscribe(listener), [host])
  const getSnapshot = useCallback(() => host.settings.getSnapshot(), [host])
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot).region
}

export function useTiboPost(
  host: BrowserPluginHost,
  id: string,
  signal: AbortSignal
): {
  record: TiboRecord | null
  loading: boolean
  error: string | null
  retry(): void
} {
  const biz = useMemo(() => new TiboBrowserBiz(host), [host])
  const region = useTiboRegion(host)
  const [record, setRecord] = useState<TiboRecord | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let active = true
    const live = (): boolean => active && !signal.aborted
    async function load(): Promise<void> {
      setLoading(true)
      setRecord(null)
      setError(null)
      try {
        const current = await biz.record(id)
        if (!live()) return
        setRecord(current)
        if (current && !current.analysis) {
          const translated = await biz.translate(id)
          if (live()) setRecord(translated)
        }
      } catch (failure) {
        if (live()) setError(errorText(failure))
      } finally {
        if (live()) setLoading(false)
      }
    }
    void load()
    return () => {
      active = false
    }
  }, [attempt, biz, id, region, signal])
  return { record, loading, error, retry: () => setAttempt((value) => value + 1) }
}

type TiboPageView = 'setup' | 'posts' | 'settings' | null

type TiboPageState = {
  snapshot: TiboSnapshot | null
  view: TiboPageView
  draft: TiboSettings | null
  saved: TiboSettings | null
  saving: boolean
  error: string | null
}

type TiboPageAction =
  | { type: 'snapshot'; snapshot: TiboSnapshot }
  | { type: 'draft'; settings: TiboSettings }
  | { type: 'settings' }
  | { type: 'posts' }
  | { type: 'saving' }
  | { type: 'saved'; snapshot: TiboSnapshot }
  | { type: 'save-failed'; error: string }
  | { type: 'error'; error: string | null }

export const initialTiboPageState: TiboPageState = {
  snapshot: null,
  view: null,
  draft: null,
  saved: null,
  saving: false,
  error: null
}

export function tiboPageReducer(state: TiboPageState, action: TiboPageAction): TiboPageState {
  switch (action.type) {
    case 'snapshot': {
      const { snapshot } = action
      return {
        ...state,
        snapshot,
        draft: state.draft ?? snapshot.settings,
        saved: state.saved ?? snapshot.settings,
        view:
          state.view ??
          (snapshot.records.length > 0 ||
          JSON.stringify(snapshot.settings) !== JSON.stringify(defaultSettings())
            ? 'posts'
            : 'setup')
      }
    }
    case 'draft':
      return state.saving ? state : { ...state, draft: action.settings }
    case 'settings':
      return !state.snapshot || state.saving || state.view !== 'posts'
        ? state
        : {
            ...state,
            view: 'settings',
            draft: state.snapshot.settings,
            saved: state.snapshot.settings,
            error: null
          }
    case 'posts':
      return state.saving ? state : { ...state, view: 'posts', draft: state.saved, error: null }
    case 'saving':
      return { ...state, saving: true, error: null }
    case 'saved':
      return {
        snapshot: action.snapshot,
        view: 'posts',
        draft: action.snapshot.settings,
        saved: action.snapshot.settings,
        saving: false,
        error: null
      }
    case 'save-failed':
      return { ...state, saving: false, error: action.error }
    case 'error':
      return { ...state, error: action.error }
  }
}

export function prepareTiboSettings(
  draft: TiboSettings,
  firstSetup: boolean,
  models: TiboModelOption[],
  modelsLoading: boolean,
  region: HostRegion
): { settings: TiboSettings; error: null } | { settings: null; error: string } {
  const parsed = settingsSchema.safeParse(firstSetup ? { ...draft, enabled: true } : draft)
  if (!parsed.success) {
    const field = parsed.error.issues[0]?.path[0]
    const message =
      field === 'intervalSeconds'
        ? tiboText(
            region,
            '检查间隔须为 30–86400 秒之间的整数。',
            'Check interval must be an integer between 30 and 86400 seconds.'
          )
        : field === 'retentionCount'
          ? tiboText(
              region,
              '保留动态须为 10–200 条之间的整数。',
              'Posts to retain must be an integer between 10 and 200.'
            )
          : tiboText(
              region,
              '启用监听前请选择翻译模型。',
              'Choose a translation model before enabling monitoring.'
            )
    return { settings: null, error: message }
  }
  if (parsed.data.enabled) {
    if (modelsLoading) {
      return {
        settings: null,
        error: tiboText(region, '正在读取模型，请稍候。', 'Models are loading. Please wait.')
      }
    }
    if (
      !models.some(
        (model) =>
          model.provider === parsed.data.model?.provider &&
          model.modelId === parsed.data.model.modelId
      )
    ) {
      return {
        settings: null,
        error: tiboText(
          region,
          '所选翻译模型当前不可用，请检查模型配置与认证。',
          'The selected translation model is unavailable. Check model configuration and authentication.'
        )
      }
    }
  }
  return { settings: parsed.data, error: null }
}

export function useTiboPage(
  host: BrowserPluginHost,
  target: BrowserSettingsPageTarget,
  signal: AbortSignal
): {
  snapshot: TiboSnapshot | null
  view: TiboPageView
  draft: TiboSettings | null
  models: TiboModelOption[]
  modelsLoading: boolean
  modelsError: string | null
  canSave: boolean
  loading: boolean
  saving: boolean
  dirty: boolean
  error: string | null
  confirmingLeave: boolean
  setDraft(settings: TiboSettings): void
  save(): Promise<void>
  reload(): void
  confirmLeave(leave: boolean): void
  showSettings(): void
  showPosts(): Promise<void>
  cancelSettings(): void
} {
  const biz = useMemo(() => new TiboBrowserBiz(host), [host])
  const region = useTiboRegion(host)
  const [page, setPage] = useState(initialTiboPageState)
  const { snapshot, view, draft, saved, saving, error } = page
  const dispatch = useCallback((action: TiboPageAction): void => {
    setPage((previous) => tiboPageReducer(previous, action))
  }, [])
  const [models, setModels] = useState<TiboModelOption[]>([])
  const [modelsLoading, setModelsLoading] = useState(true)
  const [modelsError, setModelsError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [refresh, setRefresh] = useState(0)
  const [confirmingLeave, setConfirmingLeave] = useState(false)
  const leaveResolver = useRef<((leave: boolean) => void) | null>(null)
  const queryId = useRef(0)
  const active = useRef(false)
  const dirty = draft !== null && JSON.stringify(draft) !== JSON.stringify(saved)
  const submission = draft
    ? prepareTiboSettings(draft, view === 'setup', models, modelsLoading, region)
    : null
  const canSave = !saving && (view === 'setup' || dirty) && submission?.error === null

  useEffect(() => {
    active.current = true
    let disposed = false
    const live = (): boolean => !disposed && !signal.aborted
    async function query(): Promise<void> {
      const current = ++queryId.current
      try {
        const value = await biz.snapshot()
        if (!live() || current !== queryId.current) return
        dispatch({ type: 'snapshot', snapshot: value })
      } catch (failure) {
        if (live() && current === queryId.current) {
          dispatch({ type: 'error', error: errorText(failure) })
        }
      } finally {
        if (live() && current === queryId.current) setLoading(false)
      }
    }
    void query()
    const stateOff = host.globalState.subscribe(() => {
      void query()
    })
    const connectionOff = host.connection.subscribe(() => {
      if (host.connection.getSnapshot().status === 'ready') void query()
    })
    return () => {
      disposed = true
      active.current = false
      stateOff()
      connectionOff()
    }
  }, [biz, dispatch, host, refresh, region, signal])

  useEffect(() => {
    if (view !== 'settings' && view !== 'setup') return
    let disposed = false
    const live = (): boolean => !disposed && !signal.aborted
    async function loadModels(): Promise<void> {
      setModelsLoading(true)
      setModelsError(null)
      try {
        const value = await biz.models()
        if (live()) setModels(value)
      } catch (failure) {
        if (live()) {
          setModels([])
          setModelsError(errorText(failure))
        }
      } finally {
        if (live()) setModelsLoading(false)
      }
    }
    void loadModels()
    return () => {
      disposed = true
    }
  }, [biz, refresh, signal, view])

  const confirmLeave = useCallback((leave: boolean): void => {
    const resolve = leaveResolver.current
    leaveResolver.current = null
    setConfirmingLeave(false)
    resolve?.(leave)
  }, [])

  const beforeLeave = useCallback((): boolean | Promise<boolean> => {
    if (saving) return false
    if (view === 'posts' || !dirty) return true
    leaveResolver.current?.(false)
    return new Promise<boolean>((resolve) => {
      leaveResolver.current = resolve
      setConfirmingLeave(true)
    })
  }, [dirty, saving, view])

  useEffect(() => {
    target.setBeforeLeave(beforeLeave)
    return () => {
      target.setBeforeLeave(null)
      leaveResolver.current?.(false)
      leaveResolver.current = null
    }
  }, [beforeLeave, target])

  async function save(): Promise<void> {
    if (!submission || saving) return
    if (submission.error !== null) {
      dispatch({ type: 'error', error: submission.error })
      return
    }
    dispatch({ type: 'saving' })
    try {
      const value = await biz.save(submission.settings)
      if (signal.aborted || !active.current) return
      queryId.current += 1
      dispatch({ type: 'saved', snapshot: value })
      host.notify({
        level: 'success',
        title: tiboText(
          host.settings.getSnapshot().region,
          'Tibo 监听设置已保存',
          'Tibo monitor settings saved'
        )
      })
    } catch (failure) {
      if (!signal.aborted && active.current) {
        dispatch({ type: 'save-failed', error: errorText(failure) })
      }
    }
  }

  function showSettings(): void {
    if (!snapshot || saving || view !== 'posts') return
    setModelsLoading(true)
    dispatch({ type: 'settings' })
  }

  async function showPosts(): Promise<void> {
    if (!(await beforeLeave()) || signal.aborted || !active.current) return
    dispatch({ type: 'posts' })
  }

  return {
    snapshot,
    view,
    draft,
    models,
    modelsLoading,
    modelsError,
    canSave,
    loading,
    saving,
    dirty,
    error,
    confirmingLeave,
    setDraft: (settings) => dispatch({ type: 'draft', settings }),
    save,
    reload: () => {
      if (view === 'settings' || view === 'setup') setModelsLoading(true)
      dispatch({ type: 'error', error: null })
      setRefresh((value) => value + 1)
    },
    confirmLeave,
    showSettings,
    showPosts,
    cancelSettings: () => {
      if (view === 'settings') dispatch({ type: 'posts' })
    }
  }
}
