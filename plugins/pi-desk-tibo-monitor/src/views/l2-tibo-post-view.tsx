import {
  PluginAlert,
  PluginBadge,
  PluginButton,
  PluginLoadingState,
  PluginSection
} from '@jetcrab/pi-desk-sdk/react/base'
import type { TiboRecord } from '../l4-tibo-protocol.js'
import type { HostRegion } from '@jetcrab/pi-desk-sdk/settings'
import { regionTime, tiboText } from '../l4-tibo-locale.js'

export function resetLabel(level: 'announced' | 'possible', region: HostRegion): string {
  return level === 'announced'
    ? tiboText(region, '额度重置消息', 'Quota reset announcement')
    : tiboText(region, '可能重置 · 推测', 'Possible reset · Inferred')
}

export function TiboPostView({
  record,
  region,
  link,
  loading,
  error,
  onRetry
}: {
  record: TiboRecord | null
  region: HostRegion
  link: string
  loading: boolean
  error: string | null
  onRetry(): void
}): React.JSX.Element {
  const analysis = record?.analysis
  return (
    <div className="tibo-post">
      {record ? (
        <>
          <div className="tibo-meta">
            <time dateTime={new Date(record.publishedAt).toISOString()}>
              {regionTime(record.publishedAt, region)} · {region.timeZone}
            </time>
            <a href={record.link} target="_blank" rel="noopener noreferrer">
              {tiboText(region, '原帖 ↗', 'Original post ↗')}
            </a>
          </div>
          <article className="tibo-story">
            <div className="tibo-main-post">
              <div className="tibo-author">
                Tibo <span>@thsottiaux</span>
              </div>
              <p className="tibo-copy" lang={analysis ? region.locale : 'en'}>
                {analysis?.translation ?? record.text}
              </p>
              {analysis ? (
                <details className="tibo-original">
                  <summary>{tiboText(region, '查看英文原文', 'View English original')}</summary>
                  <p className="tibo-copy" lang="en">
                    {record.text}
                  </p>
                </details>
              ) : null}
            </div>
            {record.quote ? (
              <blockquote className="tibo-quote">
                <div className="tibo-quote-head">
                  <span>
                    {tiboText(region, '引用', 'Quote from')} <strong>{record.quote.author}</strong>
                  </span>
                  <a href={record.quote.link} target="_blank" rel="noopener noreferrer">
                    {tiboText(region, '原帖 ↗', 'Original post ↗')}
                  </a>
                </div>
                <p className="tibo-copy" lang={analysis?.quoteTranslation ? region.locale : 'en'}>
                  {analysis?.quoteTranslation ?? record.quote.text}
                </p>
                {analysis?.quoteTranslation ? (
                  <details className="tibo-original">
                    <summary>{tiboText(region, '查看英文原文', 'View English original')}</summary>
                    <p className="tibo-copy" lang="en">
                      {record.quote.text}
                    </p>
                  </details>
                ) : null}
                {/(?:…|\.\.\.)\s*$/.test(record.quote.text) ? (
                  <span className="tibo-note">
                    {tiboText(region, '引用原文未完', 'Quoted original is truncated')}
                  </span>
                ) : null}
              </blockquote>
            ) : null}
          </article>
        </>
      ) : null}
      {error ? (
        <PluginAlert tone="error" density="compact">
          <span>{error}</span>
          <PluginButton size="sm" variant="secondary" disabled={loading} onClick={onRetry}>
            {tiboText(region, '重试', 'Retry')}
          </PluginButton>
        </PluginAlert>
      ) : null}
      {loading ? (
        <PluginLoadingState
          loading
          loadingLabel={
            record
              ? tiboText(region, '正在翻译…', 'Translating…')
              : tiboText(region, '正在读取动态…', 'Loading post…')
          }
        >
          {null}
        </PluginLoadingState>
      ) : null}
      {analysis ? (
        <>
          {analysis.reset.level !== 'none' ? (
            <details className="tibo-analysis">
              <summary>
                <PluginBadge tone="warning">{resetLabel(analysis.reset.level, region)}</PluginBadge>
              </summary>
              <p className="tibo-reason">{analysis.reset.reason}</p>
              <span className="tibo-note">
                {tiboText(
                  region,
                  '模型判断，非官方确认',
                  'Model assessment, not official confirmation'
                )}
              </span>
            </details>
          ) : null}
          {analysis.times.length ? (
            <PluginSection
              title={`${tiboText(region, '相关时间', 'Related times')} · ${region.timeZone}`}
              density="compact"
            >
              {analysis.times.map((time, index) => (
                <div className="tibo-time" key={index}>
                  <p className="tibo-reason">{time.localTime}</p>
                  <details className="tibo-time-details">
                    <summary>{tiboText(region, '时间依据', 'Time reference')}</summary>
                    <p className="tibo-reason">
                      {tiboText(region, '原文：', 'Original: ')}
                      {time.source}
                    </p>
                    {time.assumption ? <p className="tibo-reason">{time.assumption}</p> : null}
                  </details>
                </div>
              ))}
            </PluginSection>
          ) : null}
        </>
      ) : null}
      {!record && !loading && !error ? (
        <PluginAlert density="compact">
          <p>
            {tiboText(
              region,
              '这条帖子已超过保留条数，不再保存在本地。',
              'This post is outside the retention limit and is no longer stored locally.'
            )}
          </p>
          <a href={link} target="_blank" rel="noopener noreferrer">
            {tiboText(region, '查看原帖 ↗', 'View original post ↗')}
          </a>
        </PluginAlert>
      ) : null}
    </div>
  )
}
