import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  L3CapabilityCatalog,
  L3CapabilityMode,
  L3CapabilityModes
} from '@common/l3_modules/capability-modes/l3-capability-modes-contract'
import type { L2CapabilityModesBiz } from '../l2-capability-modes-biz'
import { l2NewCapabilityModeName } from '../l2-capability-modes-model'

interface L2CapabilityModesEditor {
  draft: L3CapabilityModes
  saved: L3CapabilityModes | null
  catalog: L3CapabilityCatalog | null
  selected: string | null
  loading: boolean
  saving: boolean
  error: string | null
  dirty: boolean
  leaveOpen: boolean
  beforeLeave(): Promise<boolean>
  decideLeave(choice: 'save' | 'discard' | 'cancel'): Promise<void>
  load(refresh?: boolean): Promise<L3CapabilityModes | null>
  select(key: string | null): Promise<void>
  add(copy?: boolean): Promise<void>
  update(mode: L3CapabilityMode): void
  remove(): void
  save(): Promise<boolean>
}

export function useL2CapabilityModes(biz: L2CapabilityModesBiz): L2CapabilityModesEditor {
  const { t } = useTranslation('capabilityModes')
  const [saved, setSaved] = useState<L3CapabilityModes | null>(null)
  const [draft, setDraft] = useState<L3CapabilityModes>({})
  const [catalog, setCatalog] = useState<L3CapabilityCatalog | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [leaveOpen, setLeaveOpen] = useState(false)
  const leaveResolve = useRef<((leave: boolean) => void) | null>(null)
  const controller = useRef<AbortController | null>(null)
  const dirty = saved !== null && JSON.stringify(saved) !== JSON.stringify(draft)

  useEffect(() => {
    const current = new AbortController()
    controller.current = current
    return (): void => {
      current.abort()
      leaveResolve.current?.(false)
      leaveResolve.current = null
    }
  }, [])

  const load = useCallback(
    async (refresh = false): Promise<L3CapabilityModes | null> => {
      if (saved !== null && !refresh) return draft
      setLoading(true)
      setError(null)
      try {
        const result = await biz.get(controller.current?.signal)
        if (controller.current?.signal.aborted) return null
        setCatalog(result.catalog)
        if (saved === null || !dirty) {
          setSaved(result.modes)
          setDraft(structuredClone(result.modes))
        }
        return saved !== null && dirty ? draft : result.modes
      } catch (cause) {
        if (!controller.current?.signal.aborted)
          setError(cause instanceof Error ? cause.message : t('catalogFailed'))
        return null
      } finally {
        if (!controller.current?.signal.aborted) setLoading(false)
      }
    },
    [biz, dirty, draft, saved, t]
  )

  const select = useCallback(
    async (key: string | null): Promise<void> => {
      if (key === null) {
        setSelected(null)
        return
      }
      const modes = await load()
      if (modes && Object.hasOwn(modes, key)) setSelected(key)
    },
    [load]
  )

  const add = useCallback(
    async (copy = false): Promise<void> => {
      const modes = await load()
      if (!modes) return
      const source = copy && selected ? modes[selected] : undefined
      const key = crypto.randomUUID()
      const name = l2NewCapabilityModeName(
        modes,
        source ? t('copySuffix', { name: source.name }) : t('newMode')
      )
      setDraft({ ...modes, [key]: { ...(source ? structuredClone(source) : {}), name } })
      setSelected(key)
    },
    [load, selected, t]
  )

  const update = useCallback(
    (mode: L3CapabilityMode): void => {
      if (selected) setDraft((current) => ({ ...current, [selected]: mode }))
    },
    [selected]
  )

  const remove = useCallback((): void => {
    if (!selected) return
    setDraft((current) =>
      Object.fromEntries(Object.entries(current).filter(([key]) => key !== selected))
    )
    setSelected(null)
  }, [selected])

  const save = useCallback(async (): Promise<boolean> => {
    if (!dirty) return true
    setSaving(true)
    setError(null)
    try {
      const normalized = await biz.replace(draft, controller.current?.signal)
      if (controller.current?.signal.aborted) return false
      setSaved(normalized)
      setDraft(structuredClone(normalized))
      return true
    } catch (cause) {
      if (!controller.current?.signal.aborted)
        setError(cause instanceof Error ? cause.message : t('saveFailed'))
      return false
    } finally {
      if (!controller.current?.signal.aborted) setSaving(false)
    }
  }, [biz, dirty, draft, t])

  const beforeLeave = useCallback((): Promise<boolean> => {
    if (!dirty) return Promise.resolve(true)
    setLeaveOpen(true)
    return new Promise<boolean>((resolve) => {
      leaveResolve.current = resolve
    })
  }, [dirty])

  const decideLeave = useCallback(
    async (choice: 'save' | 'discard' | 'cancel'): Promise<void> => {
      if (choice === 'save' && !(await save())) return
      setLeaveOpen(false)
      leaveResolve.current?.(choice !== 'cancel')
      leaveResolve.current = null
    },
    [save]
  )

  return {
    draft,
    saved,
    catalog,
    selected,
    loading,
    saving,
    error,
    dirty,
    leaveOpen,
    beforeLeave,
    decideLeave,
    load,
    select,
    add,
    update,
    remove,
    save
  }
}
