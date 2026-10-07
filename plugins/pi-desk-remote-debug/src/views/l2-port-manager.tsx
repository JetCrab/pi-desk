import { useState } from 'react'
import type { BrowserPluginHost } from '@jetcrab/pi-desk-sdk/browser'
import {
  PluginAlert,
  PluginButton,
  PluginEmptyState,
  PluginInput
} from '@jetcrab/pi-desk-sdk/react/base'
import type { RemoteDebugRegistration, RemoteDebugSettings } from '../l4-remote-debug-contract.js'
import { projectName, type RangeEditor } from '../l2-browser-biz.js'
import { CopyButton } from './l4-browser-ui.js'

const PORT_TABLE_STYLES = `
.remote-debug-range-row{display:grid;grid-template-columns:5rem minmax(4rem,1fr) 1rem minmax(4rem,1fr);gap:.5rem;align-items:center}
.remote-debug-port-table{width:100%;min-width:0}
.remote-debug-port-row{display:grid;grid-template-columns:minmax(7rem,.9fr) 6rem 5rem minmax(0,1.3fr) minmax(0,1fr) 5rem;gap:.75rem;align-items:start;border-top:1px solid var(--border);padding:.75rem 0;font-size:.875rem;line-height:1.5}
.remote-debug-port-header{border-top:0;padding:.25rem 0;font-size:.75rem;color:var(--muted-foreground)}
.remote-debug-port-cell{min-width:0;overflow-wrap:anywhere;word-break:break-word}
.remote-debug-port-label{display:none}
.remote-debug-port-number{font-variant-numeric:tabular-nums;font-weight:600;text-align:right}
.remote-debug-port-header .remote-debug-port-number{font-weight:400}
.remote-debug-port-values{display:flex;justify-content:flex-end;flex-wrap:wrap;gap:.25rem .5rem}
@container (max-width:44rem){.remote-debug-port-header{display:none}.remote-debug-port-row{grid-template-columns:repeat(2,minmax(0,1fr));gap:.5rem}.remote-debug-port-label{display:block;color:var(--muted-foreground);font-size:.75rem;font-weight:400}.remote-debug-port-owner,.remote-debug-port-path,.remote-debug-port-server,.remote-debug-port-action{grid-column:1 / -1}.remote-debug-port-owner .remote-debug-port-label{display:none}.remote-debug-port-number{text-align:left}.remote-debug-port-values{justify-content:flex-start}.remote-debug-port-action{justify-self:start}}
`

export function PortManager({
  section,
  settings,
  ranges,
  dirty,
  busy,
  loading,
  error,
  host,
  onRanges,
  onSave,
  onRemove
}: {
  section: 'allocation' | 'registry'
  settings: RemoteDebugSettings | null
  ranges: RangeEditor | null
  dirty: boolean
  busy: boolean
  loading: boolean
  error: string | null
  host: BrowserPluginHost
  onRanges(value: RangeEditor): void
  onSave(): void
  onRemove(value: RemoteDebugRegistration): void
}): React.JSX.Element {
  const [search, setSearch] = useState('')
  const matching = (settings?.registrations ?? [])
    .filter((registration) =>
      [
        registration.entryPort,
        ...registration.routePorts,
        registration.publicPort,
        registration.cwd,
        projectName(registration.cwd),
        registration.profile,
        registration.tunnelServer ?? ''
      ]
        .join(' ')
        .toLowerCase()
        .includes(search.trim().toLowerCase())
    )
    .sort(
      (left, right) =>
        left.cwd.localeCompare(right.cwd) ||
        left.profile.localeCompare(right.profile) ||
        (left.tunnelServer ?? '').localeCompare(right.tunnelServer ?? '')
    )
  return (
    <div className="remote-debug-form">
      <style>{PORT_TABLE_STYLES}</style>
      {section === 'allocation' && ranges ? (
        <form
          className="remote-debug-form remote-debug-form-width"
          onSubmit={(event) => {
            event.preventDefault()
            onSave()
          }}
        >
          <fieldset
            disabled={busy}
            style={{ margin: 0, padding: 0, minWidth: 0, border: 0 }}
            className="remote-debug-stack"
          >
            <div className="remote-debug-range-row" role="group" aria-label="本机端口范围">
              <span>本机端口</span>
              <PluginInput
                aria-label="本机起始端口"
                required
                type="number"
                min={1}
                max={65535}
                step={1}
                value={ranges.localStart}
                onChange={(event) => onRanges({ ...ranges, localStart: event.target.value })}
              />
              <span>至</span>
              <PluginInput
                aria-label="本机结束端口"
                required
                type="number"
                min={1}
                max={65535}
                step={1}
                value={ranges.localEnd}
                onChange={(event) => onRanges({ ...ranges, localEnd: event.target.value })}
              />
            </div>
            <div className="remote-debug-range-row" role="group" aria-label="公网端口范围">
              <span>公网端口</span>
              <PluginInput
                aria-label="公网起始端口"
                required
                type="number"
                min={1}
                max={65535}
                step={1}
                value={ranges.publicStart}
                onChange={(event) => onRanges({ ...ranges, publicStart: event.target.value })}
              />
              <span>至</span>
              <PluginInput
                aria-label="公网结束端口"
                required
                type="number"
                min={1}
                max={65535}
                step={1}
                value={ranges.publicEnd}
                onChange={(event) => onRanges({ ...ranges, publicEnd: event.target.value })}
              />
            </div>
          </fieldset>
          {error ? <PluginAlert tone="error">{error}</PluginAlert> : null}
          <div className="remote-debug-actions">
            <PluginButton type="submit" variant="primary" disabled={busy}>
              {busy ? '保存中…' : '保存端口范围'}
            </PluginButton>
            {dirty ? <span className="remote-debug-caption">有未保存的修改</span> : null}
          </div>
        </form>
      ) : null}
      {section === 'registry' ? (
        <div className="remote-debug-stack">
          <PluginInput
            aria-label="搜索登记"
            placeholder="搜索项目、启动项、端口或服务器"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          {matching.length ? (
            <div className="remote-debug-port-table" role="table" aria-label="已登记端口">
              <div className="remote-debug-port-row remote-debug-port-header" role="row">
                {['归属项目 / 启动项', '本地端口', '远程端口', '项目路径', '服务器', '操作'].map(
                  (label) => (
                    <div
                      key={label}
                      role="columnheader"
                      className={
                        label === '本地端口' || label === '远程端口'
                          ? 'remote-debug-port-number'
                          : undefined
                      }
                    >
                      {label}
                    </div>
                  )
                )}
              </div>
              {matching.map((registration) => (
                <div
                  className="remote-debug-port-row"
                  role="row"
                  key={`${registration.cwd}:${registration.profile}:${registration.tunnelServer ?? ''}`}
                >
                  <div className="remote-debug-port-cell remote-debug-port-owner" role="cell">
                    <span className="remote-debug-port-label">归属项目 / 启动项</span>
                    {projectName(registration.cwd)} / {registration.profile}
                  </div>
                  <div className="remote-debug-port-cell remote-debug-port-number" role="cell">
                    <span className="remote-debug-port-label">本地端口</span>
                    <div className="remote-debug-port-values">
                      {[...new Set([registration.entryPort, ...registration.routePorts])].map(
                        (port) => (
                          <span key={port}>{port}</span>
                        )
                      )}
                    </div>
                  </div>
                  <div className="remote-debug-port-cell remote-debug-port-number" role="cell">
                    <span className="remote-debug-port-label">远程端口</span>
                    {registration.publicPort}
                  </div>
                  <div className="remote-debug-port-cell remote-debug-port-path" role="cell">
                    <span className="remote-debug-port-label">项目路径</span>
                    {registration.cwd}{' '}
                    <CopyButton host={host} value={registration.cwd} label="复制目录" />
                  </div>
                  <div className="remote-debug-port-cell remote-debug-port-server" role="cell">
                    <span className="remote-debug-port-label">服务器</span>
                    {registration.tunnelServer ?? '未配置'}
                  </div>
                  <div className="remote-debug-port-cell remote-debug-port-action" role="cell">
                    <PluginButton
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => onRemove(registration)}
                    >
                      移除登记
                    </PluginButton>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <PluginEmptyState>
              {!settings
                ? loading
                  ? '读取登记中…'
                  : '登记列表尚未读取'
                : search
                  ? '没有匹配的登记，请调整搜索内容。'
                  : '暂无端口登记'}
            </PluginEmptyState>
          )}
        </div>
      ) : null}
    </div>
  )
}
