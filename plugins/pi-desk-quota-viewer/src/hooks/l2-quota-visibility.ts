import { useMemo, useRef, useState } from 'react'
import type { BrowserPluginHost } from '@jetcrab/pi-desk-sdk/browser'
import { readQuotaSnapshot, replaceQuotaSnapshot } from '../browser-runtime.js'
import { quotaBiz } from '../l2-quota-biz.js'
import { MAX_HIDDEN_ITEMS, type QuotaSnapshot } from '../protocol.js'
import { quotaText, readQuotaRegion } from '../l2-quota-locale.js'

export function useQuotaVisibility(
  snapshot: QuotaSnapshot,
  host: BrowserPluginHost,
  signal: AbortSignal,
  onClose: () => void
): {
  hidden: ReadonlySet<string>
  dirty: boolean
  saving: boolean
  error: string | null
  select(keys: readonly string[], visible: readonly string[]): void
  showAll(): void
  save(): void
} {
  const locale = readQuotaRegion(host).locale
  const [hidden, setHidden] = useState(() => new Set(snapshot.display.hiddenItemKeys))
  const [saving, setSaving] = useState(false)
  const pending = useRef(false)
  const [error, setError] = useState<string | null>(null)
  const baseline = useMemo(
    () => new Set(snapshot.display.hiddenItemKeys),
    [snapshot.display.hiddenItemKeys]
  )
  const dirty = hidden.size !== baseline.size || [...hidden].some((key) => !baseline.has(key))

  const select = (keys: readonly string[], visible: readonly string[]): void => {
    if (pending.current) return
    const selected = new Set(visible)
    const next = new Set(hidden)
    for (const key of keys) {
      if (selected.has(key)) next.delete(key)
      else next.add(key)
    }
    if (next.size > MAX_HIDDEN_ITEMS) {
      setError(
        quotaText(
          locale,
          `最多隐藏 ${MAX_HIDDEN_ITEMS} 项，请先恢复部分显示项。`,
          `You can hide up to ${MAX_HIDDEN_ITEMS} items. Restore some items first.`
        )
      )
      return
    }
    setError(null)
    setHidden(next)
  }

  const save = (): void => {
    if (pending.current || !dirty) return
    pending.current = true
    setSaving(true)
    setError(null)
    void quotaBiz
      .saveVisibility(host, [...hidden])
      .then((next) => {
        if (signal.aborted) return
        replaceQuotaSnapshot({
          ...readQuotaSnapshot(),
          display: next.display
        })
        host.notify({ level: 'success', title: quotaText(locale, '显示项已保存') })
        onClose()
      })
      .catch((cause: unknown) => {
        if (!signal.aborted) setError(cause instanceof Error ? cause.message : String(cause))
      })
      .finally(() => {
        pending.current = false
        if (!signal.aborted) setSaving(false)
      })
  }

  return {
    hidden,
    dirty,
    saving,
    error,
    select,
    save,
    showAll: (): void => {
      if (pending.current) return
      setHidden(new Set())
      setError(null)
    }
  }
}
