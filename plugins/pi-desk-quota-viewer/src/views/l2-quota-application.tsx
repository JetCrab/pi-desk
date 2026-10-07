import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import type { BrowserPluginHost } from '@jetcrab/pi-desk-sdk/browser'
import {
  PluginAlert,
  PluginButton,
  PluginEmptyState,
  PluginScroll,
  PluginSurface
} from '@jetcrab/pi-desk-sdk/react/base'
import { useQuotaBrowse } from '../hooks/l2-quota-browse.js'
import { useCurrentTime, useQuotaQuery } from '../hooks/l2-quota-query.js'
import { displayItems, quotaRecords, recordLabel } from '../l2-quota-model.js'
import { quotaText, readQuotaRegion } from '../l2-quota-locale.js'
import { QUOTA_STYLES } from '../l2-quota-styles.js'
import { QuotaFilters, QuotaPagination } from './l2-quota-navigation.js'
import { QuotaRecordRow } from './l2-quota-record.js'
import { QuotaVisibilityDialog } from './l2-quota-visibility.js'

export function QuotaApplication({
  host,
  signal
}: {
  host: BrowserPluginHost
  signal: AbortSignal
}): React.JSX.Element {
  const { snapshot, loading, requesting, error, refresh } = useQuotaQuery(host, signal)
  const now = useCurrentTime()
  const region = readQuotaRegion(host)
  const t = (text: string, en?: string): string => quotaText(region.locale, text, en)
  const hidden = useMemo(
    () => new Set(snapshot.display.hiddenItemKeys),
    [snapshot.display.hiddenItemKeys]
  )
  const records = useMemo(() => quotaRecords(snapshot.sources, hidden), [hidden, snapshot.sources])
  const browse = useQuotaBrowse(records, snapshot.sources)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [visibilityOpen, setVisibilityOpen] = useState(false)
  const viewport = useRef<HTMLDivElement>(null)
  const refreshing = snapshot.sources.some((source) => source.refreshing)
  const failures = snapshot.sources.filter((source) => source.error)
  const resourceCount = snapshot.sources.reduce(
    (count, source) => count + source.resources.length,
    0
  )
  const hiddenCount = displayItems(snapshot.sources).filter((item) => hidden.has(item.key)).length
  const names = useMemo(() => {
    const counts = new Map<string, number>()
    for (const record of records) {
      const key = JSON.stringify([record.source.adapter, recordLabel(record)])
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    return counts
  }, [records])

  useEffect(() => {
    viewport.current?.scrollTo({ top: 0 })
  }, [browse.adapter, browse.query, browse.page])

  const expandedKey =
    expanded && records.some((record) => record.key === expanded) ? expanded : null
  const setAdapter = (adapter: string): void => {
    setExpanded(null)
    browse.setAdapter(adapter)
  }
  const setQuery = (query: string): void => {
    setExpanded(null)
    browse.setQuery(query)
  }
  const setPage = (page: number): void => {
    setExpanded(null)
    browse.setPage(page)
  }

  let emptyLabel: string
  if (snapshot.sources.length === 0 && loading) emptyLabel = '正在读取额度…'
  else if (snapshot.sources.length === 0 && (error || snapshot.error))
    emptyLabel = '暂时无法读取额度来源'
  else if (snapshot.sources.length === 0)
    emptyLabel = '尚未启用额度来源，请在“设置 → 额度设置”中添加。'
  else if (browse.query || browse.adapter) emptyLabel = '没有匹配的可见记录'
  else emptyLabel = '当前额度已全部隐藏'

  return (
    <PluginSurface className="quota-application" data-quota-application="">
      <style>{QUOTA_STYLES}</style>
      <QuotaFilters
        sources={snapshot.sources}
        locale={region.locale}
        adapter={browse.adapter}
        query={browse.query}
        onAdapter={setAdapter}
        onQuery={setQuery}
        actions={
          <>
            <PluginButton
              size="sm"
              variant="secondary"
              data-quota-visibility=""
              disabled={resourceCount === 0}
              onClick={() => setVisibilityOpen(true)}
            >
              {hiddenCount > 0
                ? t(`显示项 · ${hiddenCount} 项隐藏`, `Display items · ${hiddenCount} hidden`)
                : t('显示项')}
            </PluginButton>
            <PluginButton
              size="sm"
              variant="secondary"
              data-quota-refresh=""
              disabled={requesting || refreshing}
              onClick={refresh}
            >
              {t(requesting || refreshing ? '刷新中…' : '刷新')}
            </PluginButton>
          </>
        }
      />
      <PluginScroll
        className="quota-record-scroll"
        viewportClassName="quota-record-viewport"
        viewportRef={viewport}
        aria-label={t('额度记录')}
      >
        {snapshot.error ? (
          <PluginAlert tone="error" density="compact">
            {snapshot.error}
          </PluginAlert>
        ) : null}
        {error ? (
          <PluginAlert tone="error" density="compact">
            {error}
          </PluginAlert>
        ) : null}
        {failures.length > 0 ? (
          <details className="quota-source-notices">
            <summary className="quota-warning">
              {t(`${failures.length} 个来源异常`, `${failures.length} source errors`)}
            </summary>
            <div className="quota-source-errors">
              {failures.map((source) => (
                <div key={source.sourceId}>
                  <strong>{source.name}</strong>
                  <div className="quota-error-text">{source.error}</div>
                </div>
              ))}
            </div>
          </details>
        ) : null}
        {browse.items.length === 0 ? (
          <PluginEmptyState density="compact">
            {t(emptyLabel)}
            <div className="quota-actions quota-empty-actions">
              {browse.query ? (
                <PluginButton size="sm" variant="ghost" onClick={() => setQuery('')}>
                  {t('清除搜索')}
                </PluginButton>
              ) : null}
              {browse.adapter ? (
                <PluginButton size="sm" variant="ghost" onClick={() => setAdapter('')}>
                  {t('全部渠道')}
                </PluginButton>
              ) : null}
              {hiddenCount > 0 ? (
                <PluginButton size="sm" variant="secondary" onClick={() => setVisibilityOpen(true)}>
                  {t('恢复显示项')}
                </PluginButton>
              ) : null}
            </div>
          </PluginEmptyState>
        ) : (
          browse.items.map((record, index) => (
            <Fragment key={record.key}>
              {browse.items[index - 1]?.source.adapter !== record.source.adapter ? (
                <h2 className="quota-channel-heading">{t(record.source.adapterLabel)}</h2>
              ) : null}
              <QuotaRecordRow
                record={record}
                now={now}
                region={region}
                resetTimeFormat={snapshot.display.resetTimeFormat}
                expanded={expandedKey === record.key}
                duplicateName={
                  (names.get(JSON.stringify([record.source.adapter, recordLabel(record)])) ?? 0) > 1
                }
                onToggle={() => setExpanded(expandedKey === record.key ? null : record.key)}
              />
            </Fragment>
          ))
        )}
      </PluginScroll>
      <QuotaPagination
        locale={region.locale}
        page={browse.page}
        pageCount={browse.pageCount}
        total={browse.total}
        onPage={setPage}
      />
      {visibilityOpen ? (
        <QuotaVisibilityDialog
          snapshot={snapshot}
          host={host}
          signal={signal}
          onClose={() => setVisibilityOpen(false)}
        />
      ) : null}
    </PluginSurface>
  )
}
