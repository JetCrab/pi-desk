import { useId } from 'react'
import { PluginAlert, PluginButton } from '@jetcrab/pi-desk-sdk/react/base'
import {
  dataSourceLabel,
  formatCountdown,
  formatRatio,
  formatTimestamp,
  formatValue,
  quotaPrimaryValue,
  quotaTone,
  recordIndex,
  recordLabel,
  recordPlan,
  remainingRatio,
  resourceLabel,
  scopeText,
  summarySlots,
  windowLabel,
  type QuotaRecord
} from '../l2-quota-model.js'
import { quotaText, type QuotaRegion } from '../l2-quota-locale.js'
import type { QuotaDisplaySettings, QuotaResource } from '../protocol.js'

function ResourceMetric({
  resource,
  now,
  region,
  resetTimeFormat
}: {
  resource: QuotaResource
  now: number
  region: QuotaRegion
  resetTimeFormat: QuotaDisplaySettings['resetTimeFormat']
}): React.JSX.Element {
  const primary =
    resource.kind === 'balance'
      ? { label: '余额', value: resource.available }
      : quotaPrimaryValue(resource)
  const ratio = resource.kind === 'quota' ? remainingRatio(resource) : null
  const label = resourceLabel(resource, region.locale)
  const resetAt = resource.kind === 'quota' ? resource.window.resetAt : null
  const resetTime =
    resetAt === null
      ? null
      : resetTimeFormat === 'countdown'
        ? formatCountdown(resetAt, now, region.locale)
        : quotaText(
            region.locale,
            `${formatTimestamp(resetAt, region)} 重置`,
            `Resets ${formatTimestamp(resetAt, region)}`
          )
  return (
    <div
      className="quota-metric"
      data-quota-resource={resource.key}
      data-quota-tone={quotaTone(ratio)}
    >
      <span className="quota-meta">
        {label}
        {resource.kind === 'quota' ? ` · ${quotaText(region.locale, primary.label)}` : ''}
      </span>
      <div className="quota-metric-reading">
        {resetTime ? <span className="quota-meta">{resetTime}</span> : null}
        <span className="quota-metric-value">
          {formatValue(primary.value, resource.unit, region.locale)}
          {resource.unit.kind !== 'percentage' && ratio !== null ? (
            <span className="quota-meta"> {formatRatio(ratio, region.locale)}</span>
          ) : null}
        </span>
      </div>
      {ratio !== null ? (
        <div
          className="quota-progress"
          role="progressbar"
          aria-label={quotaText(region.locale, `${label}剩余额度`, `${label} remaining`)}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(ratio * 100)}
        >
          <span style={{ width: `${ratio * 100}%` }} />
        </div>
      ) : null}
    </div>
  )
}

function ResourceDetail({
  resource,
  region
}: {
  resource: QuotaResource
  region: QuotaRegion
}): React.JSX.Element {
  const scope = scopeText(resource, region.locale)
  const t = (text: string, en?: string): string => quotaText(region.locale, text, en)
  return (
    <div className="quota-resource-detail" data-quota-detail-resource={resource.key}>
      <div className="quota-detail-resource-name">
        <strong>{resourceLabel(resource, region.locale)}</strong>
        {scope ? <span className="quota-meta">{scope}</span> : null}
        {resource.kind === 'quota' ? (
          <span className="quota-meta">{windowLabel(resource, region.locale)}</span>
        ) : null}
      </div>
      {resource.kind === 'balance' ? (
        <div className="quota-detail-values">
          <span>
            {t(resource.unit.kind === 'currency' ? '余额' : '可用')}{' '}
            <strong>{formatValue(resource.available, resource.unit, region.locale)}</strong>
          </span>
          {resource.expiresAt !== null ? (
            <span className="quota-meta">
              {t('到期', 'Expires')} {formatTimestamp(resource.expiresAt, region)}
            </span>
          ) : null}
        </div>
      ) : (
        <div className="quota-detail-values">
          <span>
            {t('剩余')}{' '}
            <strong>{formatValue(resource.values.remaining, resource.unit, region.locale)}</strong>
          </span>
          <span>
            {t('已用')} {formatValue(resource.values.used, resource.unit, region.locale)}
          </span>
          {resource.unit.kind !== 'percentage' ? (
            <span>
              {t('总额')} {formatValue(resource.values.limit, resource.unit, region.locale)}
            </span>
          ) : null}
          {resource.window.resetAt !== null ? (
            <span className="quota-meta">
              {t('重置', 'Resets')} {formatTimestamp(resource.window.resetAt, region)}
            </span>
          ) : null}
        </div>
      )}
    </div>
  )
}

export function QuotaRecordRow({
  record,
  now,
  expanded,
  duplicateName,
  region,
  resetTimeFormat,
  onToggle
}: {
  record: QuotaRecord
  now: number
  expanded: boolean
  duplicateName: boolean
  region: QuotaRegion
  resetTimeFormat: QuotaDisplaySettings['resetTimeFormat']
  onToggle(): void
}): React.JSX.Element {
  const detailId = useId()
  const { source } = record
  const t = (text: string, en?: string): string => quotaText(region.locale, text, en)
  const label = recordLabel(record)
  const stale = source.staleAt !== null && now >= source.staleAt
  const index = recordIndex(record)
  const metrics = summarySlots(record).filter((resource) => resource !== null)
  const plan = recordPlan(record)
  const resetCredits =
    source.adapter === 'cpa-codex'
      ? record.resources.find(
          (resource) =>
            resource.kind === 'balance' && resource.key.split('/')[1] === 'reset-credits'
        )
      : undefined
  const meta = [
    record.account && source.name !== source.adapterLabel ? source.name : null,
    duplicateName ? `${source.sourceId.slice(0, 8)}${index ? ` / ${index}` : ''}` : null
  ]
    .filter(Boolean)
    .join(' · ')
  return (
    <section className="quota-record" data-quota-record={record.key}>
      <div className="quota-record-summary">
        <div className="quota-record-identity">
          <div className="quota-record-label">
            <span className="quota-record-name">{label}</span>
            {plan ? <span className="quota-meta quota-plan">{plan}</span> : null}
          </div>
          {meta ? <span className="quota-meta quota-truncate">{meta}</span> : null}
          <div className="quota-record-state">
            {resetCredits?.kind === 'balance' ? (
              <span className="quota-meta">
                {t('剩余重置次数')}：
                {formatValue(resetCredits.available, resetCredits.unit, region.locale)}
              </span>
            ) : null}
            {source.error ? <span className="quota-warning">{t('来源异常')}</span> : null}
            {stale ? <span className="quota-warning">{t('已过期')}</span> : null}
            {source.refreshing ? <span className="quota-meta">{t('刷新中')}</span> : null}
          </div>
        </div>
        <div
          className="quota-metrics"
          style={{ gridTemplateColumns: `repeat(${metrics.length || 1}, minmax(0, 1fr))` }}
        >
          {record.resources.length > 0 ? (
            metrics.map((resource) => (
              <ResourceMetric
                key={resource.key}
                resource={resource}
                now={now}
                region={region}
                resetTimeFormat={resetTimeFormat}
              />
            ))
          ) : (
            <span className="quota-meta">
              {t(
                source.refreshing ? '正在查询…' : source.error ? '未取得额度数据' : '暂无额度数据'
              )}
            </span>
          )}
        </div>
        <PluginButton
          size="sm"
          variant="ghost"
          className="quota-detail-toggle"
          aria-label={t(
            `${expanded ? '收起' : '查看'}${label}详情`,
            `${expanded ? 'Collapse' : 'View'} ${label} details`
          )}
          aria-expanded={expanded}
          aria-controls={detailId}
          onClick={onToggle}
        >
          {t(expanded ? '收起' : '详情')}
        </PluginButton>
      </div>
      {expanded ? (
        <div className="quota-record-detail" id={detailId}>
          <div className="quota-detail-identity">
            <strong>{label}</strong>
            <span className="quota-meta">
              {t('来源', 'Source')}：{source.name} · {t(dataSourceLabel(source.dataSource))}
            </span>
            {index ? (
              <span className="quota-meta">
                {t('CPA 索引', 'CPA index')}：{index}
              </span>
            ) : null}
            {duplicateName ? (
              <span className="quota-meta">
                {t('来源 ID', 'Source ID')}：{source.sourceId}
              </span>
            ) : null}
            <span className="quota-meta">
              {source.observedAt === null
                ? t('尚未取得数据')
                : t(
                    `数据更新于 ${formatTimestamp(source.observedAt, region)}`,
                    `Updated ${formatTimestamp(source.observedAt, region)}`
                  )}
            </span>
          </div>
          {source.error ? (
            <PluginAlert tone="warning" density="compact">
              {source.error}
            </PluginAlert>
          ) : null}
          {record.resources.map((resource) => (
            <ResourceDetail key={resource.key} resource={resource} region={region} />
          ))}
        </div>
      ) : null}
    </section>
  )
}
