import { useMemo, useState } from 'react'
import type { BrowserPluginHost } from '@jetcrab/pi-desk-sdk/browser'
import {
  PluginAlert,
  PluginButton,
  PluginCheckbox,
  PluginDialog,
  PluginEmptyState,
  PluginInput,
  PluginSelect
} from '@jetcrab/pi-desk-sdk/react/base'
import { useQuotaVisibility } from '../hooks/l2-quota-visibility.js'
import { quotaText, readQuotaRegion } from '../l2-quota-locale.js'
import {
  displayItems,
  groupChannels,
  isWeeklyResource,
  matchesSearch,
  resourceLabel
} from '../l2-quota-model.js'
import type { QuotaSnapshot } from '../protocol.js'

export function QuotaVisibilityDialog({
  snapshot,
  host,
  signal,
  onClose
}: {
  snapshot: QuotaSnapshot
  host: BrowserPluginHost
  signal: AbortSignal
  onClose(): void
}): React.JSX.Element {
  const model = useQuotaVisibility(snapshot, host, signal, onClose)
  const locale = readQuotaRegion(host).locale
  const t = (text: string): string => quotaText(locale, text)
  const items = useMemo(() => displayItems(snapshot.sources), [snapshot.sources])
  const [adapter, setAdapter] = useState('')
  const [query, setQuery] = useState('')
  const visible = items.filter(
    (item) =>
      (!adapter || item.adapter === adapter) &&
      matchesSearch(query, t(item.adapterLabel), resourceLabel(item.resource, locale))
  )

  return (
    <PluginDialog
      open
      title={t('显示项')}
      size="lg"
      onOpenChange={(open) => {
        if (!open && !model.saving) onClose()
      }}
      footer={
        <>
          <PluginButton
            size="sm"
            variant="ghost"
            disabled={model.saving || model.hidden.size === 0}
            onClick={model.showAll}
          >
            {t('全部显示')}
          </PluginButton>
          <PluginButton size="sm" variant="secondary" disabled={model.saving} onClick={onClose}>
            {t('取消')}
          </PluginButton>
          <PluginButton
            size="sm"
            variant="primary"
            data-quota-visibility-save=""
            disabled={model.saving || !model.dirty}
            onClick={model.save}
          >
            {t(model.saving ? '保存中…' : '保存')}
          </PluginButton>
        </>
      }
    >
      <div className="quota-visibility">
        <div className="quota-visibility-filters">
          <PluginSelect
            label={t('渠道')}
            value={adapter || 'all'}
            disabled={model.saving}
            options={[
              { value: 'all', label: t('全部渠道') },
              ...groupChannels(items).map(([item]) => ({
                value: item.adapter,
                label: t(item.adapterLabel)
              }))
            ]}
            onValueChange={(value) => setAdapter(value === 'all' ? '' : (value ?? ''))}
          />
          <PluginInput
            aria-label={t('搜索渠道或显示内容')}
            placeholder={t('搜索渠道或显示内容')}
            value={query}
            disabled={model.saving}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        {model.error ? (
          <PluginAlert tone="error" density="compact">
            {model.error}
          </PluginAlert>
        ) : null}
        {visible.length === 0 ? (
          <PluginEmptyState density="compact">
            {t(items.length === 0 ? '暂无可选择的额度' : '没有匹配的显示内容')}
          </PluginEmptyState>
        ) : (
          groupChannels(visible).map((channel) => {
            const first = channel[0]
            const all = items.filter((item) => item.adapter === first.adapter)
            const keys = all.map((item) => item.key)
            const weekly = all
              .filter((item) => isWeeklyResource(item.resource))
              .map((item) => item.key)
            return (
              <section className="quota-visibility-channel" key={first.adapter}>
                <div className="quota-visibility-heading">
                  <h3 className="quota-section-title">{t(first.adapterLabel)}</h3>
                  {weekly.length > 0 && weekly.length < keys.length ? (
                    <PluginButton
                      size="sm"
                      variant="ghost"
                      disabled={model.saving}
                      onClick={() => model.select(keys, weekly)}
                    >
                      {t('仅周')}
                    </PluginButton>
                  ) : null}
                </div>
                <div className="quota-visibility-options">
                  {channel.map((item) => (
                    <label className="quota-selection" key={item.key}>
                      <PluginCheckbox
                        checked={!model.hidden.has(item.key)}
                        disabled={model.saving}
                        onChange={(event) =>
                          model.select([item.key], event.target.checked ? [item.key] : [])
                        }
                      />
                      <span>{resourceLabel(item.resource, locale)}</span>
                    </label>
                  ))}
                </div>
              </section>
            )
          })
        )}
      </div>
    </PluginDialog>
  )
}
