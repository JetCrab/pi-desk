import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import type {
  BrowserPluginHost,
  BrowserSettingsPageImplementation,
  BrowserSettingsPageTarget
} from '@jetcrab/pi-desk-sdk/browser'
import {
  PluginConfirmDialog,
  PluginErrorBoundary,
  PluginLoadingState,
  PluginPanelHeader,
  PluginSurface,
  PluginTab,
  PluginTabList
} from '@jetcrab/pi-desk-sdk/react/base'
import { tiboText } from './l4-tibo-locale.js'
import { useTiboRegion, useTiboPage, useTiboPost } from './l2-browser-hooks.js'
import { TiboFeedView } from './views/l2-tibo-feed-view.js'
import { TiboSettingsView } from './views/l2-tibo-settings-view.js'
import { TiboPostView } from './views/l2-tibo-post-view.js'
import { TIBO_STYLES } from './l2-tibo-styles.js'
import type { TiboSummary } from './l4-tibo-protocol.js'

let mountId = 0

function PostPreview({
  host,
  signal,
  post
}: {
  host: BrowserPluginHost
  signal: AbortSignal
  post: TiboSummary
}): React.JSX.Element {
  const detail = useTiboPost(host, post.id, signal)
  const region = useTiboRegion(host)
  return <TiboPostView {...detail} region={region} link={post.link} onRetry={detail.retry} />
}

function Settings({
  host,
  target,
  signal
}: {
  host: BrowserPluginHost
  target: BrowserSettingsPageTarget
  signal: AbortSignal
}): React.JSX.Element {
  const state = useTiboPage(host, target, signal)
  const region = useTiboRegion(host)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const selected =
    state.snapshot?.records.find((post) => post.id === selectedId) ?? state.snapshot?.records[0]
  return (
    <PluginSurface className="tibo-page">
      <style>{TIBO_STYLES}</style>
      <PluginPanelHeader
        title={tiboText(region, 'Tibo 动态', 'Tibo posts')}
        density="compact"
        actions={
          <PluginTabList label={tiboText(region, 'Tibo 页面', 'Tibo pages')}>
            <PluginTab
              active={state.view === 'posts'}
              disabled={!state.snapshot || state.saving}
              onClick={() => void state.showPosts()}
            >
              {tiboText(region, '动态', 'Posts')}
            </PluginTab>
            <PluginTab
              active={state.view === 'settings'}
              disabled={!state.snapshot || state.saving}
              onClick={state.showSettings}
            >
              {tiboText(region, '设置', 'Settings')}
            </PluginTab>
          </PluginTabList>
        }
      />
      <PluginLoadingState
        loading={state.loading && !state.snapshot}
        error={!state.snapshot ? state.error : null}
        onRetry={state.reload}
        loadingLabel={tiboText(region, '正在加载…', 'Loading…')}
        retryLabel={tiboText(region, '重新加载', 'Reload')}
      >
        {state.view === 'settings' ? <TiboSettingsView state={state} region={region} /> : null}
        {state.view === 'posts' && state.snapshot ? (
          <TiboFeedView
            snapshot={state.snapshot}
            region={region}
            selectedId={selected?.id ?? null}
            error={state.error}
            onSelectPost={setSelectedId}
            onSettings={state.showSettings}
          >
            {selected ? (
              <PostPreview key={selected.id} host={host} signal={signal} post={selected} />
            ) : null}
          </TiboFeedView>
        ) : null}
      </PluginLoadingState>
      <PluginConfirmDialog
        open={state.confirmingLeave}
        title={tiboText(region, '放弃未保存的设置？', 'Discard unsaved settings?')}
        description={tiboText(
          region,
          '离开后将丢弃本次修改。',
          'Your changes will be discarded when you leave.'
        )}
        confirmLabel={tiboText(region, '放弃修改', 'Discard changes')}
        cancelLabel={tiboText(region, '取消', 'Cancel')}
        onConfirm={() => state.confirmLeave(true)}
        onOpenChange={(open) => {
          if (!open) state.confirmLeave(false)
        }}
      />
    </PluginSurface>
  )
}

const implementation: BrowserSettingsPageImplementation = {
  mount({ container, host, target, signal }) {
    const root = createRoot(container, {
      identifierPrefix: `tibo-settings-${++mountId}-`
    })
    root.render(
      <PluginErrorBoundary
        fallback={(error, retry) => (
          <PluginLoadingState
            loading={false}
            error={error}
            onRetry={retry}
            retryLabel={tiboText(host.settings.getSnapshot().region, '重新加载', 'Reload')}
          >
            {null}
          </PluginLoadingState>
        )}
        onError={(error) =>
          host.notify({
            level: 'error',
            title: tiboText(
              host.settings.getSnapshot().region,
              'Tibo 设置渲染失败',
              'Failed to render Tibo settings'
            ),
            description: error.message
          })
        }
      >
        <Settings host={host} target={target} signal={signal} />
      </PluginErrorBoundary>
    )
    return () => root.unmount()
  }
}

export default implementation
