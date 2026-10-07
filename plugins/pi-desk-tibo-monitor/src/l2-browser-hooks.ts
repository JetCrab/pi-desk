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

export function useTiboPage(
  host: BrowserPluginHost,
  target: BrowserSettingsPageTarget,
  signal: AbortSignal
): {
  snapshot: TiboSnapshot | null
  view: 'posts' | 'settings' | null
  draft: TiboSettings | null
  models: TiboModelOption[]
  modelsLoading: boolean
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
} {
  const biz = useMemo(() => new TiboBrowserBiz(host), [host])
  const region = useTiboRegion(host)
  const [snapshot, setSnapshot] = useState<TiboSnapshot | null>(null)
  const [view, setView] = useState<'posts' | 'settings' | null>(null)
  const [draft, setDraft] = useState<TiboSettings | null>(null)
  const [saved, setSaved] = useState<TiboSettings | null>(null)
  const [models, setModels] = useState<TiboModelOption[]>([])
  const [modelsLoading, setModelsLoading] = useState(true)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [refresh, setRefresh] = useState(0)
  const [confirmingLeave, setConfirmingLeave] = useState(false)
  const leaveResolver = useRef<((leave: boolean) => void) | null>(null)
  const queryId = useRef(0)
  const active = useRef(false)
  const dirty = draft !== null && JSON.stringify(draft) !== JSON.stringify(saved)

  useEffect(() => {
    active.current = true
    let disposed = false
    const live = (): boolean => !disposed && !signal.aborted
    async function query(): Promise<void> {
      const current = ++queryId.current
      try {
        const value = await biz.snapshot()
        if (!live() || current !== queryId.current) return
        setSnapshot(value)
        setDraft((previous) => previous ?? value.settings)
        setSaved((previous) => previous ?? value.settings)
        setView(
          (previous) =>
            previous ??
            (value.records.length > 0 ||
            JSON.stringify(value.settings) !== JSON.stringify(defaultSettings())
              ? 'posts'
              : 'settings')
        )
      } catch (failure) {
        if (live() && current === queryId.current) setError(errorText(failure))
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
  }, [biz, host, refresh, region, signal])

  useEffect(() => {
    if (view !== 'settings') return
    let disposed = false
    const live = (): boolean => !disposed && !signal.aborted
    async function loadModels(): Promise<void> {
      setModelsLoading(true)
      try {
        const value = await biz.models()
        if (live()) setModels(value)
      } catch (failure) {
        if (live()) setError(errorText(failure))
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
    if (view !== 'settings' || !dirty) return true
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
    if (!draft || saving) return
    const parsed = settingsSchema.safeParse(draft)
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? tiboText(region, '设置无效', 'Invalid settings'))
      return
    }
    setSaving(true)
    setError(null)
    try {
      const value = await biz.save(parsed.data)
      if (signal.aborted || !active.current) return
      queryId.current += 1
      setSnapshot(value)
      setDraft(value.settings)
      setSaved(value.settings)
      setView('posts')
      host.notify({
        level: 'success',
        title: tiboText(
          host.settings.getSnapshot().region,
          'Tibo 监听设置已保存',
          'Tibo monitor settings saved'
        )
      })
    } catch (failure) {
      if (!signal.aborted && active.current) setError(errorText(failure))
    } finally {
      if (!signal.aborted && active.current) setSaving(false)
    }
  }

  function showSettings(): void {
    if (!snapshot || saving || view === 'settings') return
    setDraft(snapshot.settings)
    setSaved(snapshot.settings)
    setError(null)
    setView('settings')
  }

  async function showPosts(): Promise<void> {
    if (!(await beforeLeave()) || signal.aborted || !active.current) return
    setDraft(saved)
    setError(null)
    setView('posts')
  }

  return {
    snapshot,
    view,
    draft,
    models,
    modelsLoading,
    loading,
    saving,
    dirty,
    error,
    confirmingLeave,
    setDraft,
    save,
    reload: () => {
      setError(null)
      setRefresh((value) => value + 1)
    },
    confirmLeave,
    showSettings,
    showPosts
  }
}
