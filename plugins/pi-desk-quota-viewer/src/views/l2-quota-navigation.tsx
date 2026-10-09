import type { ReactNode } from 'react'
import {
  PluginButton,
  PluginInput,
  PluginScroll,
  PluginSelect,
  PluginTab,
  PluginTabList
} from '@jetcrab/pi-desk-sdk/react/base'
import { groupChannels, QUOTA_PAGE_SIZE } from '../l2-quota-model.js'
import type { QuotaSourceSnapshot } from '../protocol.js'
import { quotaText, type QuotaLocale } from '../l2-quota-locale.js'

export function QuotaFilters({
  sources,
  locale,
  adapter,
  query,
  onAdapter,
  onQuery,
  actions,
  disabled = false
}: {
  sources: readonly QuotaSourceSnapshot[]
  locale: QuotaLocale
  adapter: string
  query: string
  onAdapter(value: string): void
  onQuery(value: string): void
  actions?: ReactNode
  disabled?: boolean
}): React.JSX.Element {
  const t = (text: string): string => quotaText(locale, text)
  const options = [
    { value: '', label: t('全部渠道') },
    ...groupChannels(sources).map(([source]) => ({
      value: source.adapter,
      label: t(source.adapterLabel)
    }))
  ]
  return (
    <div className="quota-filters">
      <div className="quota-toolbar">
        <PluginInput
          className="quota-search"
          aria-label={t('搜索渠道、来源或账号')}
          placeholder={t('搜索渠道、来源或账号')}
          value={query}
          disabled={disabled}
          onChange={(event) => onQuery(event.target.value)}
        />
        <div className="quota-actions">{actions}</div>
      </div>
      {options.length > 2 ? (
        <>
          <PluginScroll
            orientation="horizontal"
            className="quota-channel-tabs"
            aria-label={t('额度渠道')}
          >
            <PluginTabList label={t('额度渠道')} className="quota-tabs">
              {options.map((option) => (
                <PluginTab
                  key={option.value}
                  active={adapter === option.value}
                  disabled={disabled}
                  onClick={() => onAdapter(option.value)}
                >
                  {option.label}
                </PluginTab>
              ))}
            </PluginTabList>
          </PluginScroll>
          <PluginSelect
            className="quota-channel-select"
            label={t('渠道')}
            value={adapter}
            options={options}
            disabled={disabled}
            onValueChange={(value) => onAdapter(value ?? '')}
          />
        </>
      ) : null}
    </div>
  )
}

export function QuotaPagination({
  locale,
  page,
  pageCount,
  total,
  onPage,
  disabled = false
}: {
  locale: QuotaLocale
  page: number
  pageCount: number
  total: number
  onPage(page: number): void
  disabled?: boolean
}): React.JSX.Element | null {
  if (pageCount <= 1) return null
  const t = (text: string): string => quotaText(locale, text)
  return (
    <nav className="quota-pagination" aria-label={t('记录分页')}>
      <span className="quota-meta">
        {(page - 1) * QUOTA_PAGE_SIZE + 1}–{Math.min(page * QUOTA_PAGE_SIZE, total)} / {total}{' '}
        {quotaText(locale, '条', 'records')}
      </span>
      <div className="quota-actions">
        <PluginButton
          size="sm"
          variant="ghost"
          disabled={disabled || page <= 1}
          onClick={() => onPage(page - 1)}
        >
          {t('上一页')}
        </PluginButton>
        <span className="quota-meta">
          {page} / {pageCount}
        </span>
        <PluginButton
          size="sm"
          variant="ghost"
          disabled={disabled || page >= pageCount}
          onClick={() => onPage(page + 1)}
        >
          {t('下一页')}
        </PluginButton>
      </div>
    </nav>
  )
}
