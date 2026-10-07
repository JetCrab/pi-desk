import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { BrowserPluginHost, BrowserSettingsPageTarget } from '@jetcrab/pi-desk-sdk/browser'
import { quotaBiz } from '../l2-quota-biz.js'
import {
  type QuotaDisplaySettings,
  type QuotaAdapterDescriptor,
  type QuotaAdapterSettingField,
  type QuotaSettingsSaveSource,
  type QuotaSettingsSnapshot
} from '../protocol.js'
import { readQuotaSnapshot, replaceQuotaSnapshot } from '../browser-runtime.js'
import { quotaText, readQuotaRegion } from '../l2-quota-locale.js'

export interface DraftSource extends QuotaSettingsSaveSource {
  draftKey: string
}

function comparable(draft: readonly DraftSource[]): string {
  return JSON.stringify(draft.map(({ draftKey: _draftKey, ...source }) => source))
}

export function fieldId(source: DraftSource, key: string): string {
  return `quota-${source.draftKey}-${key}`.replace(/[^a-zA-Z0-9_-]/g, '-')
}

function fieldError(source: DraftSource, field: QuotaAdapterSettingField): string | null {
  const value = source.values[field.key]?.trim() ?? ''
  if (field.required && !value) return `${field.label}不能为空`
  if (field.kind === 'select' && value && !field.options.some((option) => option.value === value)) {
    return `${field.label}选项无效`
  }
  if (field.kind === 'url' && value) {
    try {
      new URL(value)
    } catch {
      return `${field.label}必须是有效 URL`
    }
  }
  return null
}

interface QuotaSettingsModel {
  settings: QuotaSettingsSnapshot
  draft: DraftSource[]
  selected: DraftSource | null
  selectedKey: string | null
  descriptor: QuotaAdapterDescriptor | undefined
  validationErrors: Map<string, string>
  changedKeys: ReadonlySet<string>
  dirty: boolean
  loading: boolean
  saving: boolean
  error: string | null
  removedCount: number
  leaveOpen: boolean
  resetTimeFormat: QuotaDisplaySettings['resetTimeFormat']
  setResetTimeFormat(value: QuotaDisplaySettings['resetTimeFormat']): void
  select(key: string): void
  add(adapter: string): void
  update(change: (source: DraftSource) => DraftSource): void
  remove(): void
  discard(): void
  reload(): void
  save(): void
  finishLeave(leave: boolean): void
}

export function useQuotaSettings(
  host: BrowserPluginHost,
  target: BrowserSettingsPageTarget,
  signal: AbortSignal
): QuotaSettingsModel {
  const [settings, setSettings] = useState<QuotaSettingsSnapshot>({
    error: null,
    adapters: [],
    sources: [],
    display: { resetTimeFormat: 'countdown', hiddenItemKeys: [] }
  })
  const locale = readQuotaRegion(host).locale
  const [resetTimeFormat, setFormat] =
    useState<QuotaDisplaySettings['resetTimeFormat']>('countdown')
  const resetTimeFormatRef = useRef(resetTimeFormat)
  const baselineFormatRef = useRef(resetTimeFormat)
  const [draft, setDraft] = useState<DraftSource[]>([])
  const [baseline, setBaseline] = useState<DraftSource[]>([])
  const draftRef = useRef(draft)
  const baselineRef = useRef(baseline)
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const selectedKeyRef = useRef(selectedKey)
  const [loading, setLoading] = useState(true)
  const loadingRef = useRef(false)
  const [saving, setSaving] = useState(false)
  const savingRef = useRef(false)
  const [error, setError] = useState<string | null>(null)
  const [focusTarget, setFocusTarget] = useState<{ id: string } | null>(null)
  const [leaveOpen, setLeaveOpen] = useState(false)
  const leaveResolve = useRef<((leave: boolean) => void) | null>(null)

  const setResetTimeFormat = (value: QuotaDisplaySettings['resetTimeFormat']): void => {
    if (savingRef.current) return
    resetTimeFormatRef.current = value
    setFormat(value)
  }

  const select = useCallback((key: string | null): void => {
    selectedKeyRef.current = key
    setSelectedKey(key)
  }, [])
  const replaceDraft = useCallback((next: DraftSource[]): void => {
    draftRef.current = next
    setDraft(next)
  }, [])
  const isDirty = useCallback(
    (): boolean =>
      comparable(draftRef.current) !== comparable(baselineRef.current) ||
      resetTimeFormatRef.current !== baselineFormatRef.current,
    []
  )

  const apply = useCallback(
    (next: QuotaSettingsSnapshot, preferredKey?: string): void => {
      const nextDraft = next.sources.map((source) => ({
        ...structuredClone(source),
        draftKey: source.sourceId
      }))
      setSettings(next)
      resetTimeFormatRef.current = next.display.resetTimeFormat
      baselineFormatRef.current = next.display.resetTimeFormat
      setFormat(next.display.resetTimeFormat)
      baselineRef.current = nextDraft
      setBaseline(nextDraft)
      replaceDraft(nextDraft)
      const key = preferredKey ?? selectedKeyRef.current
      select(
        nextDraft.some((source) => source.draftKey === key) ? key : (nextDraft[0]?.draftKey ?? null)
      )
    },
    [replaceDraft, select]
  )

  const load = useCallback(async (): Promise<void> => {
    if (signal.aborted || loadingRef.current || savingRef.current || isDirty()) return
    loadingRef.current = true
    setLoading(true)
    setError(null)
    try {
      const next = await quotaBiz.loadSettings(host)
      // 请求发出以后可能继续编辑，返回时也必须保护草稿。
      if (!signal.aborted && !isDirty() && !savingRef.current) apply(next)
    } catch (cause) {
      if (!signal.aborted) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      loadingRef.current = false
      if (!signal.aborted) setLoading(false)
    }
  }, [apply, host, isDirty, signal])

  useEffect(() => {
    let active = true
    queueMicrotask(() => {
      if (active) void load()
    })
    const dispose = host.connection.subscribe(() => {
      if (host.connection.getSnapshot().status === 'ready') void load()
    })
    return () => {
      active = false
      void dispose()
    }
  }, [host, load])

  useEffect(() => {
    target.setBeforeLeave(() => {
      if (savingRef.current) return false
      if (!isDirty()) return true
      return new Promise<boolean>((resolve) => {
        leaveResolve.current?.(false)
        leaveResolve.current = resolve
        setLeaveOpen(true)
      })
    })
    return () => {
      target.setBeforeLeave(null)
      leaveResolve.current?.(false)
      leaveResolve.current = null
    }
  }, [isDirty, target])

  useEffect(() => {
    if (!focusTarget) return
    const frame = window.requestAnimationFrame(() => {
      const field = document.getElementById(focusTarget.id)
      field?.focus()
      field?.scrollIntoView({ block: 'nearest' })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [focusTarget])

  const adapterByName = useMemo(
    () => new Map(settings.adapters.map((item) => [item.adapter, item])),
    [settings.adapters]
  )
  const validationErrors = useMemo(() => {
    const result = new Map<string, string>()
    for (const source of draft) {
      if (!source.name.trim()) result.set(`${source.draftKey}:name`, '来源名称不能为空')
      const descriptor = adapterByName.get(source.adapter)
      if (!descriptor) {
        result.set(`${source.draftKey}:adapter`, '当前渠道不可用')
        continue
      }
      for (const field of descriptor.fields) {
        const message = fieldError(source, field)
        if (message) result.set(`${source.draftKey}:${field.key}`, message)
      }
    }
    return result
  }, [adapterByName, draft])

  const add = (adapter: string): void => {
    const descriptor = adapterByName.get(adapter)
    if (!descriptor || savingRef.current || draftRef.current.length >= 50) return
    const source: DraftSource = {
      draftKey: `draft-${crypto.randomUUID()}`,
      adapter,
      name: descriptor.label,
      enabled: true,
      values: Object.fromEntries(
        descriptor.fields.map((field) => [field.key, field.defaultValue ?? ''])
      )
    }
    replaceDraft([...draftRef.current, source])
    select(source.draftKey)
    setFocusTarget({
      id: fieldId(source, descriptor.fields.find((field) => field.required)?.key ?? 'name')
    })
  }

  const update = (change: (source: DraftSource) => DraftSource): void => {
    if (savingRef.current) return
    replaceDraft(
      draftRef.current.map((source) =>
        source.draftKey === selectedKeyRef.current ? change(source) : source
      )
    )
  }

  const remove = (): void => {
    if (savingRef.current) return
    const index = draftRef.current.findIndex((source) => source.draftKey === selectedKeyRef.current)
    const next = draftRef.current.filter((source) => source.draftKey !== selectedKeyRef.current)
    replaceDraft(next)
    select(next[Math.min(index, next.length - 1)]?.draftKey ?? null)
  }

  const save = (): void => {
    if (savingRef.current || loadingRef.current || !isDirty()) return
    const firstError = validationErrors.keys().next().value as string | undefined
    if (firstError) {
      const source = draft.find((item) => firstError.startsWith(`${item.draftKey}:`))
      if (source) {
        select(source.draftKey)
        const field = firstError.slice(source.draftKey.length + 1)
        setFocusTarget({ id: fieldId(source, field === 'adapter' ? 'name' : field) })
      }
      return
    }
    savingRef.current = true
    setSaving(true)
    setError(null)
    const submitted = draftRef.current
    const selectedIndex = submitted.findIndex(
      (source) => source.draftKey === selectedKeyRef.current
    )
    void quotaBiz
      .saveSources(
        host,
        submitted.map(({ draftKey: _draftKey, ...source }) => source),
        resetTimeFormatRef.current !== baselineFormatRef.current
          ? resetTimeFormatRef.current
          : undefined
      )
      .then((next) => {
        if (signal.aborted) return
        // Runtime 保留提交数组顺序，新草稿由同次响应收敛到真实 sourceId。
        apply(next, next.sources[selectedIndex]?.sourceId)
        replaceQuotaSnapshot({ ...readQuotaSnapshot(), display: next.display })
        host.notify({ level: 'success', title: quotaText(locale, '额度设置已保存') })
      })
      .catch((cause: unknown) => {
        if (!signal.aborted) setError(cause instanceof Error ? cause.message : String(cause))
      })
      .finally(() => {
        savingRef.current = false
        if (!signal.aborted) setSaving(false)
      })
  }

  const selected = draft.find((source) => source.draftKey === selectedKey) ?? null
  return {
    settings,
    draft,
    selected,
    selectedKey,
    descriptor: selected ? adapterByName.get(selected.adapter) : undefined,
    validationErrors,
    changedKeys: new Set(
      draft
        .filter((source) => {
          const previous = baseline.find((item) => item.draftKey === source.draftKey)
          return !previous || comparable([source]) !== comparable([previous])
        })
        .map((source) => source.draftKey)
    ),
    dirty:
      comparable(draft) !== comparable(baseline) ||
      resetTimeFormat !== settings.display.resetTimeFormat,
    loading,
    saving,
    error,
    leaveOpen,
    resetTimeFormat,
    setResetTimeFormat,
    removedCount: baseline.filter(
      (source) => !draft.some((item) => item.sourceId === source.sourceId)
    ).length,
    select,
    add,
    update,
    remove,
    save,
    discard: (): void => {
      if (savingRef.current) return
      const next = structuredClone(baselineRef.current)
      replaceDraft(next)
      resetTimeFormatRef.current = baselineFormatRef.current
      setFormat(baselineFormatRef.current)
      setError(null)
      select(
        next.some((source) => source.draftKey === selectedKeyRef.current)
          ? selectedKeyRef.current
          : (next[0]?.draftKey ?? null)
      )
    },
    reload: (): void => {
      void load()
    },
    finishLeave: (leave): void => {
      const resolve = leaveResolve.current
      leaveResolve.current = null
      setLeaveOpen(false)
      resolve?.(leave)
    }
  }
}
