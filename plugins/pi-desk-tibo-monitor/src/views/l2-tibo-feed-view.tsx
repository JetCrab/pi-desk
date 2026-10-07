import { useRef, useState, type ReactNode } from 'react'
import {
  PluginActionRow,
  PluginAlert,
  PluginBadge,
  PluginButton,
  PluginLoadingState
} from '@jetcrab/pi-desk-sdk/react/base'
import type { TiboSnapshot } from '../l4-tibo-protocol.js'
import type { HostRegion } from '@jetcrab/pi-desk-sdk/settings'
import { regionTime, tiboText } from '../l4-tibo-locale.js'
import { resetLabel } from './l2-tibo-post-view.js'

export function TiboFeedView({
  snapshot,
  region,
  selectedId,
  error,
  onSelectPost,
  onSettings,
  children
}: {
  snapshot: TiboSnapshot
  region: HostRegion
  selectedId: string | null
  error: string | null
  onSelectPost(id: string): void
  onSettings(): void
  children: ReactNode
}): React.JSX.Element {
  const [visibleCount, setVisibleCount] = useState(10)
  const history = useRef<HTMLDetailsElement>(null)
  const failure = error ?? snapshot.status.error
  return (
    <div className="tibo-feed">
      {failure ? (
        <PluginAlert tone="error" density="compact">
          {failure}
        </PluginAlert>
      ) : null}
      {snapshot.records.length > 1 ? (
        <details className="tibo-history" ref={history}>
          <summary>
            {tiboText(region, '最近动态', 'Recent posts')}{' '}
            <span className="tibo-note">{snapshot.records.length}</span>
          </summary>
          <div className="tibo-records">
            {snapshot.records.slice(0, visibleCount).map((record) => (
              <button
                type="button"
                className="tibo-record"
                key={record.id}
                aria-current={record.id === selectedId ? 'true' : undefined}
                onClick={() => {
                  onSelectPost(record.id)
                  if (history.current) history.current.open = false
                }}
              >
                <div className="tibo-record-top">
                  <time className="tibo-note">{regionTime(record.publishedAt, region)}</time>
                  {record.resetLevel && record.resetLevel !== 'none' ? (
                    <PluginBadge tone="warning">
                      {resetLabel(record.resetLevel, region)}
                    </PluginBadge>
                  ) : null}
                </div>
                <p className="tibo-preview">{record.preview}</p>
                {record.quotePreview ? (
                  <p className="tibo-preview tibo-preview-quote">
                    {tiboText(region, '引用', 'Quote from')} {record.quotePreview}
                  </p>
                ) : null}
              </button>
            ))}
          </div>
          {snapshot.records.length > visibleCount ? (
            <PluginActionRow>
              <PluginButton
                variant="secondary"
                size="sm"
                onClick={() => setVisibleCount((count) => count + 10)}
              >
                {tiboText(region, '更多动态', 'More posts')}
              </PluginButton>
            </PluginActionRow>
          ) : null}
        </details>
      ) : null}
      {snapshot.records.length ? (
        children
      ) : snapshot.status.polling ? (
        <PluginLoadingState
          loading
          loadingLabel={tiboText(region, '正在读取最新动态…', 'Loading recent posts…')}
        >
          {null}
        </PluginLoadingState>
      ) : (
        <div className="tibo-empty">
          <p>{tiboText(region, '暂无动态', 'No posts yet')}</p>
          <PluginButton variant="secondary" onClick={onSettings}>
            {tiboText(region, '设置', 'Settings')}
          </PluginButton>
        </div>
      )}
    </div>
  )
}
