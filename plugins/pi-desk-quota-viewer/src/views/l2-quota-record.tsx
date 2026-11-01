import { useId } from 'react'
import { PluginButton } from '@jetcrab/pi-desk-sdk/react/base'
import {
  formatCompactCountdown,
  formatTimestamp,
  formatValue,
  quotaPrimaryValue,
  quotaTone,
  quotaTypeLabel,
  recordDetails,
  recordIndex,
  recordLabel,
  recordPlan,
  recordResetCredits,
  remainingRatio,
  resourceLabel,
  scopeText,
  shortResourceLabel,
  summarySlots,
  type QuotaRecord,
  type QuotaSupplementaryDetail
} from '../l2-quota-model.js'
import { quotaText, type QuotaRegion } from '../l2-quota-locale.js'
import type { QuotaDisplaySettings, QuotaResource } from '../protocol.js'

interface ResourceMetricProps {
  resource: QuotaResource
  now: number
  region: QuotaRegion
  resetTimeFormat: QuotaDisplaySettings['resetTimeFormat']
  quotaType?: string
}

function ResourceMetric({
  resource,
  now,
  region,
  resetTimeFormat,
  quotaType
}: ResourceMetricProps): React.JSX.Element {
  const primary =
    resource.kind === 'balance'
      ? { label: '余额', value: resource.available }
      : quotaPrimaryValue(resource)
  const ratio = resource.kind === 'quota' ? remainingRatio(resource) : null
  const fullLabel = resourceLabel(resource, region.locale)
  const label = shortResourceLabel(resource, region.locale)
  const resetAt = resource.kind === 'quota' ? resource.window.resetAt : null
  const resetTime =
    resetTimeFormat === 'countdown'
      ? formatCompactCountdown(resetAt, now, region.locale, quotaType)
      : resetAt === null
        ? null
        : formatTimestamp(resetAt, region)
  const resetLabel =
    resetAt === null
      ? undefined
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
      <div className="quota-metric-reading">
        <span className="quota-metric-label" title={fullLabel}>
          {label}
        </span>
        {resetTime ? (
          <span className="quota-metric-reset" title={resetLabel} aria-label={resetLabel}>
            {resetTime}
          </span>
        ) : null}
        <strong className="quota-metric-value">
          {['已用', '总额'].includes(primary.label)
            ? `${quotaText(region.locale, primary.label)} `
            : ''}
          {formatValue(primary.value, resource.unit, region.locale)}
        </strong>
      </div>
      {ratio !== null ? (
        <div
          className="quota-progress"
          role="progressbar"
          aria-label={quotaText(region.locale, `${fullLabel}剩余额度`, `${fullLabel} remaining`)}
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

function ResourceSupplement({
  detail,
  region
}: {
  detail: QuotaSupplementaryDetail
  region: QuotaRegion
}): React.JSX.Element {
  const scope = scopeText({ ...detail.resource, scope: detail.scope }, region.locale)
  return (
    <div className="quota-resource-supplement" data-quota-supplement={detail.resource.key}>
      <span>{resourceLabel(detail.resource, region.locale)}</span>
      <div>
        {scope ? <span>{scope}</span> : null}
        {detail.expiresAt !== null ? (
          <span>
            {quotaText(region.locale, '到期', 'Expires')}{' '}
            {formatTimestamp(detail.expiresAt, region)}
          </span>
        ) : null}
      </div>
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
  const primary =
    resource.kind === 'balance'
      ? { label: '可用', value: resource.available }
      : quotaPrimaryValue(resource)
  const scope = scopeText(
    {
      ...resource,
      scope: Object.fromEntries(
        Object.entries(resource.scope).filter(
          ([key, value]) =>
            ['organization', 'project', 'region', 'key', 'description'].includes(key) &&
            value.trim()
        )
      )
    },
    region.locale
  )
  const time = resource.kind === 'balance' ? resource.expiresAt : resource.window.resetAt
  return (
    <div className="quota-resource-detail" data-quota-detail-resource={resource.key}>
      <span>{resourceLabel(resource, region.locale)}</span>
      <div>
        <strong>
          {resource.kind === 'quota' ? `${quotaText(region.locale, primary.label)} ` : ''}
          {formatValue(primary.value, resource.unit, region.locale)}
        </strong>
        {scope ? <span>{scope}</span> : null}
        {time !== null ? (
          <span>
            {quotaText(
              region.locale,
              resource.kind === 'balance' ? '到期' : '重置',
              resource.kind === 'balance' ? 'Expires' : 'Resets'
            )}{' '}
            {formatTimestamp(time, region)}
          </span>
        ) : null}
      </div>
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
  const { source, account } = record
  const t = (text: string, en?: string): string => quotaText(region.locale, text, en)
  const label = recordLabel(record)
  const plan = recordPlan(record)
  const resetCredits = recordResetCredits(record)
  const resetCount = resetCredits
    ? resetCredits.available.state === 'known'
      ? new Intl.NumberFormat(region.locale).format(resetCredits.available.value)
      : formatValue(resetCredits.available, resetCredits.unit, region.locale)
    : null
  const metrics = summarySlots(record).filter((resource) => resource !== null)
  const detail = recordDetails(record)
  const stale = source.staleAt !== null && now >= source.staleAt
  const status =
    account?.status === 'disabled'
      ? '已停用'
      : account?.status === 'paused'
        ? '已暂停'
        : account?.status === 'blocked'
          ? '访问受限'
          : account?.error || source.error
            ? '异常'
            : stale
              ? '已过期'
              : source.refreshing
                ? '刷新中'
                : null
  return (
    <section className="quota-record" data-quota-record={record.key}>
      <div className="quota-record-summary" data-has-details={detail.hasDetails}>
        <div className="quota-record-identity">
          <span
            className="quota-record-name"
            title={
              duplicateName ? `${label} · ${source.name} · ${recordIndex(record) ?? ''}` : label
            }
          >
            {label}
          </span>
          <div className="quota-record-tags">
            {account ? <span className="quota-tag">{t(quotaTypeLabel(account.type))}</span> : null}
            {plan ? <span className="quota-tag quota-plan">{plan}</span> : null}
            {resetCount !== null ? (
              <span className="quota-tag" data-quota-resource="reset-credits">
                {t(`剩余重置${resetCount}`, `Remaining resets ${resetCount}`)}
              </span>
            ) : null}
            {status ? (
              <span className={status === '刷新中' ? 'quota-tag' : 'quota-tag quota-warning'}>
                {t(status)}
              </span>
            ) : null}
            {detail.hasDetails ? (
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
            ) : null}
          </div>
        </div>
        <div className="quota-metrics">
          {metrics.length > 0 ? (
            metrics.map((resource) => (
              <ResourceMetric
                key={resource.key}
                resource={resource}
                now={now}
                region={region}
                resetTimeFormat={resetTimeFormat}
                quotaType={account?.type}
              />
            ))
          ) : resetCredits ? null : (
            <span className="quota-meta quota-metrics-empty">
              {t(
                detail.resources.length > 0
                  ? '更多额度见详情'
                  : account?.resources.length
                    ? '当前额度已全部隐藏'
                    : source.refreshing
                      ? '正在查询…'
                      : account?.error || source.error
                        ? '未取得额度数据'
                        : '暂无额度数据'
              )}
            </span>
          )}
        </div>
      </div>
      {expanded && detail.hasDetails ? (
        <div className="quota-record-detail" id={detailId}>
          <dl className="quota-detail-metadata">
            <div>
              <dt>{t('来源', 'Source')}</dt>
              <dd>{detail.source}</dd>
            </div>
            {detail.type ? (
              <div>
                <dt>{t('额度类型')}</dt>
                <dd>{t(detail.type)}</dd>
              </div>
            ) : null}
            {duplicateName && account ? (
              <div>
                <dt>{t('账号标识', 'Account key')}</dt>
                <dd>{account.key}</dd>
              </div>
            ) : null}
            {detail.observedAt !== null ? (
              <div>
                <dt>{t('额度快照更新于')}</dt>
                <dd>{formatTimestamp(detail.observedAt, region)}</dd>
              </div>
            ) : null}
            {detail.errors.length > 0 ? (
              <div className="quota-detail-error">
                <dt>{t('异常原因', 'Error')}</dt>
                <dd>{detail.errors.join(' · ')}</dd>
              </div>
            ) : null}
          </dl>
          {detail.resources.map((resource) => (
            <ResourceDetail key={resource.key} resource={resource} region={region} />
          ))}
          {detail.supplements.map((supplement) => (
            <ResourceSupplement key={supplement.resource.key} detail={supplement} region={region} />
          ))}
        </div>
      ) : null}
    </section>
  )
}
