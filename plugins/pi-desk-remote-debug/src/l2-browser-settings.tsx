import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import type {
  BrowserPluginHost,
  BrowserSettingsPageImplementation,
  BrowserSettingsPageTarget
} from '@jetcrab/pi-desk-sdk/browser'
import {
  PluginAlert,
  PluginButton,
  PluginConfirmDialog,
  PluginErrorBoundary,
  PluginField,
  PluginHostProvider,
  PluginSurface,
  PluginTab,
  PluginTabList
} from '@jetcrab/pi-desk-sdk/react/base'
import type { RemoteDebugBrowserEvents } from './l4-browser-events.js'
import type { RemoteDebugRegistration } from './l4-remote-debug-contract.js'
import { useSettings } from './hooks/l2-use-settings.js'
import { useDraftGuard } from './hooks/l2-use-draft-guard.js'
import { PortManager } from './views/l2-port-manager.js'
import { CopyButton, REMOTE_DEBUG_LAYOUT } from './views/l4-browser-ui.js'

function Settings({
  host,
  target,
  signal,
  events
}: {
  host: BrowserPluginHost
  target: BrowserSettingsPageTarget
  signal: AbortSignal
  events: RemoteDebugBrowserEvents
}): React.JSX.Element {
  const state = useSettings(host, signal, events)
  const guard = useDraftGuard(target, state.dirtyRanges, state.busy)
  const [removing, setRemoving] = useState<RemoteDebugRegistration | null>(null)
  const [tab, setTab] = useState<'connection' | 'allocation' | 'registry'>('registry')
  const connectionAddress = state.settings?.tunnelServer ?? null
  return (
    <PluginSurface className="remote-debug-settings" data-remote-debug-settings="">
      <style>{REMOTE_DEBUG_LAYOUT}</style>
      <div className="remote-debug-heading">
        <h2>远程调试</h2>
        <PluginButton
          size="sm"
          variant="ghost"
          disabled={state.loading || state.busy}
          onClick={() => {
            void state.refresh()
          }}
        >
          {state.loading ? '同步中…' : '刷新'}
        </PluginButton>
      </div>
      <PluginTabList label="远程调试设置" className="remote-debug-settings-tabs">
        <PluginTab active={tab === 'connection'} onClick={() => setTab('connection')}>
          连接
        </PluginTab>
        <PluginTab active={tab === 'allocation'} onClick={() => setTab('allocation')}>
          端口分配
        </PluginTab>
        <PluginTab active={tab === 'registry'} onClick={() => setTab('registry')}>
          端口登记
        </PluginTab>
      </PluginTabList>
      {state.error ? <PluginAlert tone="error">{state.error}</PluginAlert> : null}
      <div hidden={tab !== 'connection'} role="tabpanel" aria-label="连接">
        <PluginField
          label="连接地址"
          description="在桌面端设置连接。"
          className="remote-debug-form-width"
        >
          <div className="remote-debug-address-row">
            <span className="remote-debug-path">
              {state.settings
                ? (connectionAddress ?? '未配置')
                : state.loading
                  ? '读取中…'
                  : '尚未读取'}
            </span>
            {connectionAddress ? <CopyButton host={host} value={connectionAddress} /> : null}
          </div>
        </PluginField>
      </div>
      <div
        hidden={tab === 'connection'}
        role="tabpanel"
        aria-label={tab === 'allocation' ? '端口分配' : '端口登记'}
      >
        <PortManager
          section={tab === 'allocation' ? 'allocation' : 'registry'}
          settings={state.settings}
          ranges={state.ranges}
          dirty={state.dirtyRanges}
          busy={state.busy}
          loading={state.loading}
          error={state.rangeError}
          host={host}
          onRanges={state.setRanges}
          onSave={() => {
            void state.saveRangeDraft()
          }}
          onRemove={setRemoving}
        />
      </div>
      <PluginConfirmDialog
        open={guard.confirming}
        title="放弃未保存的修改？"
        description="尚未保存的端口范围将被放弃。"
        confirmLabel="放弃修改"
        onConfirm={() => guard.answer(true)}
        onOpenChange={(open) => {
          if (!open) guard.answer(false)
        }}
      />
      <PluginConfirmDialog
        open={removing !== null}
        title="移除端口登记？"
        description={
          removing ? (
            <span className="remote-debug-path">
              {removing.cwd} / {removing.profile}
            </span>
          ) : undefined
        }
        confirmLabel="移除登记"
        tone="danger"
        pending={state.busy}
        onOpenChange={(open) => {
          if (!open && !state.busy) setRemoving(null)
        }}
        onConfirm={async (): Promise<void> => {
          if (removing && (await state.removeRegistration(removing)) && !signal.aborted)
            setRemoving(null)
        }}
      >
        <p className="remote-debug-muted">
          将移除这条记录中的全部端口登记。仅清除全局登记，不删除项目配置文件；下次发现项目时仍会登记。
        </p>
        {state.error ? <PluginAlert tone="error">{state.error}</PluginAlert> : null}
      </PluginConfirmDialog>
    </PluginSurface>
  )
}

export function createRemoteDebugSettings(
  events: RemoteDebugBrowserEvents
): BrowserSettingsPageImplementation {
  return {
    mount({ container, host, target, signal }): () => void {
      const root = createRoot(container)
      root.render(
        <PluginErrorBoundary>
          <PluginHostProvider host={host}>
            <Settings host={host} target={target} signal={signal} events={events} />
          </PluginHostProvider>
        </PluginErrorBoundary>
      )
      return (): void => root.unmount()
    }
  }
}
