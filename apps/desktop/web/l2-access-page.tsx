import { useId, useState, type KeyboardEvent } from 'react'
import { useAccess } from './hooks/l2-use-access'
import { formatAccessConnectionInfo, publicAccessUrl } from './l2-access-biz'
import type { PublicationSnapshot, TunnelMode, TunnelSnapshot } from './l4-desktop-ipc'
import { DesktopHeader, DesktopIcon, DesktopMenu } from './l4-desktop-ui'
import { useDesktopConfirm } from './l4-desktop-confirm'
import { AccessDetails, type AccessDetail } from './views/l2-access-details'
import { ForwardList, PublicationList } from './views/l2-access-lists'
import { AccessSettings } from './views/l2-access-settings'
import { TunnelPortEditor } from './views/l2-tunnel-port-editor'

type AccessTab = 'publication' | 'forward'

export function AccessPage({
  port,
  localUrls,
  tunnel,
  readError,
  refresh,
  onDirty,
  onBack
}: {
  port: number | null
  localUrls: readonly string[]
  tunnel: TunnelSnapshot | undefined
  readError: string
  refresh: () => void
  onDirty: (dirty: boolean) => void
  onBack: () => void
}): React.JSX.Element {
  const confirm = useDesktopConfirm()
  const access = useAccess(refresh, onDirty)
  const [tab, setTab] = useState<AccessTab>('publication')
  const [selectedDetail, setSelectedDetail] = useState<{
    kind: AccessTab
    localPort: number
  } | null>(null)
  const tabId = useId()
  let detail: AccessDetail | null = null
  if (selectedDetail?.kind === 'publication') {
    const row = tunnel?.publications.find((item) => item.localPort === selectedDetail.localPort)
    if (row) detail = { kind: 'publication', row }
  } else if (selectedDetail?.kind === 'forward') {
    const row = tunnel?.forwards.find((item) => item.localPort === selectedDetail.localPort)
    if (row) detail = { kind: 'forward', row }
  }
  const connectionInfo = (localPort: number): string =>
    tunnel?.providerId ? formatAccessConnectionInfo(tunnel.providerId, localPort) : ''
  const publicUrl = (row: PublicationSnapshot): string | null =>
    row.publicAddr ? publicAccessUrl(localUrls, row.localPort, row.publicAddr) : null
  const rowError = (kind: AccessTab, localPort: number): string =>
    access.errorTarget === `${kind}:${localPort}` ? access.error : ''
  const remove = async (kind: AccessTab, localPort: number): Promise<void> => {
    if (
      await confirm({
        title:
          kind === 'publication'
            ? `删除端口 ${localPort} 的共享？`
            : `移除本地端口 ${localPort} 的连接？`,
        description: '将断开此项的 TCP 连接，其他端口不受影响。',
        confirmLabel: kind === 'publication' ? '删除' : '移除',
        danger: true
      })
    )
      await access.remove(kind, localPort)
  }
  const toggle = async (kind: AccessTab, localPort: number, enabled: boolean): Promise<void> => {
    if (
      !enabled &&
      !(await confirm({
        title:
          kind === 'publication'
            ? `停止共享端口 ${localPort}？`
            : `断开本地端口 ${localPort} 的连接？`,
        description: '此项的现有 TCP 连接将中断，配置会保留。',
        confirmLabel: kind === 'publication' ? '停止共享' : '断开连接',
        danger: true
      }))
    )
      return
    access.toggle(kind, localPort, enabled)
  }
  const setMode = async (mode: TunnelMode): Promise<void> => {
    if (mode === tunnel?.mode) return
    if (
      !(await confirm({
        title: '切换远端连接策略？',
        description: '当前远端连接会断开并重建，本地端口保持不变。本机共享不受影响。',
        confirmLabel: '切换策略'
      }))
    )
      return
    access.setMode(mode)
  }
  const savePort = async (): Promise<void> => {
    if (
      access.editor &&
      access.editor.originalPort !== null &&
      !(await confirm({
        title: '保存端口设置？',
        description: '修改运行中的端口会中断该项的现有 TCP 连接。',
        confirmLabel: '保存'
      }))
    )
      return
    await access.savePort()
  }
  const changeTab = (event: KeyboardEvent<HTMLButtonElement>): void => {
    let next: AccessTab
    if (event.key === 'Home') next = 'publication'
    else if (event.key === 'End') next = 'forward'
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight')
      next = tab === 'publication' ? 'forward' : 'publication'
    else return
    event.preventDefault()
    setTab(next)
    document.getElementById(`${tabId}-${next}`)?.focus()
  }
  return (
    <main className="desktop-settings access-page">
      <DesktopHeader />
      <div className="page-heading access-heading">
        <button
          className="icon-button"
          type="button"
          aria-label="返回"
          disabled={access.busy}
          onClick={onBack}
        >
          <DesktopIcon name="back" />
        </button>
        <div className="grow">
          <h1>远程访问</h1>
          <p className="access-server-state muted">
            {access.loadError
              ? '无法读取服务器设置'
              : access.configured === null
                ? '正在读取设置…'
                : access.configured
                  ? '服务器已配置'
                  : '服务器未配置'}
          </p>
        </div>
        <button type="button" disabled={access.busy} onClick={access.openSettings}>
          <DesktopIcon name="settings" />
          设置
        </button>
      </div>
      {access.configured === false && (
        <div className="access-setup">
          <span>先设置服务器，再共享或连接端口。</span>
          <button
            className="primary"
            type="button"
            disabled={access.busy}
            onClick={access.openSettings}
          >
            设置服务器
          </button>
        </div>
      )}
      {access.loadError && !access.settingsOpen && (
        <p className="page-error" role="alert">
          {access.loadError}
        </p>
      )}
      {(readError || tunnel?.error || (access.errorTarget === 'page' && access.error)) && (
        <div className="page-error" role="alert">
          <p>{readError || tunnel?.error || access.error}</p>
          {readError && (
            <button type="button" disabled={access.busy} onClick={refresh}>
              重新读取状态
            </button>
          )}
        </div>
      )}
      {tunnel?.restartRequired && (
        <p className="access-notice" role="status">
          设置已更新，重启应用后生效。
        </p>
      )}
      <div className="access-tabs" role="tablist" aria-label="远程访问方式">
        {(['publication', 'forward'] as const).map((kind) => (
          <button
            key={kind}
            type="button"
            role="tab"
            id={`${tabId}-${kind}`}
            aria-controls={`${tabId}-${kind}-panel`}
            aria-selected={tab === kind}
            tabIndex={tab === kind ? 0 : -1}
            onClick={() => setTab(kind)}
            onKeyDown={changeTab}
          >
            {kind === 'publication' ? '本机共享' : '远端连接'}
          </button>
        ))}
      </div>
      {!tunnel && !readError && (
        <p className="access-empty" role="status">
          正在读取远程访问状态…
        </p>
      )}
      {tunnel && (
        <section
          className="access-panel"
          role="tabpanel"
          id={`${tabId}-${tab}-panel`}
          aria-labelledby={`${tabId}-${tab}`}
          tabIndex={0}
        >
          <div className="access-toolbar">
            <span className="muted">
              {tab === 'publication'
                ? `${tunnel.publications.length} 个共享端口`
                : `${tunnel.forwards.length} 个远端连接`}
            </span>
            <div className="actions">
              {tab === 'forward' && (
                <DesktopMenu
                  label="远端连接策略"
                  trigger={
                    <>
                      <span>策略：{tunnel.mode === 'auto' ? '自动' : '仅中继'}</span>
                      <DesktopIcon name="chevron" />
                    </>
                  }
                >
                  {(['auto', 'relay-only'] as const).map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      disabled={access.busy}
                      aria-pressed={tunnel.mode === mode}
                      onClick={() => void setMode(mode)}
                    >
                      {tunnel.mode === mode && <DesktopIcon name="check" />}
                      {mode === 'auto' ? '自动 · 优先直连' : '仅中继'}
                    </button>
                  ))}
                </DesktopMenu>
              )}
              <button
                className="primary"
                type="button"
                disabled={access.busy || access.configured !== true}
                onClick={() =>
                  access.edit(
                    tab === 'publication'
                      ? {
                          kind: 'publication',
                          originalPort: null,
                          localPort: port ? String(port) : '',
                          publicPort: '',
                          enabled: true
                        }
                      : {
                          kind: 'forward',
                          originalPort: null,
                          connectionInfo: '',
                          localPort: '',
                          enabled: true
                        }
                  )
                }
              >
                <DesktopIcon name="plus" />
                {tab === 'publication' ? '共享端口' : '添加连接'}
              </button>
            </div>
          </div>
          {tab === 'forward' && access.errorTarget === 'mode' && access.error && (
            <p className="page-error" role="alert">
              {access.error}
            </p>
          )}
          {tab === 'publication' ? (
            <PublicationList
              rows={tunnel.publications}
              selectedPort={port}
              providerReady={Boolean(tunnel.providerId)}
              busy={access.busy}
              copied={access.copied}
              connectionInfo={(row) => connectionInfo(row.localPort)}
              publicUrl={publicUrl}
              errorFor={(localPort) => rowError('publication', localPort)}
              onCopy={(row) =>
                access.copy(connectionInfo(row.localPort), `publication:${row.localPort}`)
              }
              onCopyPublic={(row) =>
                access.copy(publicUrl(row) ?? row.publicAddr!, `publication:${row.localPort}`)
              }
              onOpenPublic={(row) => {
                const url = publicUrl(row)
                if (url) access.openUrl(url, `publication:${row.localPort}`)
              }}
              onEdit={(row) =>
                access.edit({
                  kind: 'publication',
                  originalPort: row.localPort,
                  localPort: String(row.localPort),
                  publicPort: row.publicPort === null ? '' : String(row.publicPort),
                  enabled: row.enabled
                })
              }
              onToggle={(row) =>
                void toggle('publication', row.localPort, row.phase === 'failed' || !row.enabled)
              }
              onRemove={(row) => void remove('publication', row.localPort)}
              onDetails={(row) =>
                setSelectedDetail({ kind: 'publication', localPort: row.localPort })
              }
            />
          ) : (
            <ForwardList
              rows={tunnel.forwards}
              busy={access.busy}
              copied={access.copied}
              errorFor={(localPort) => rowError('forward', localPort)}
              onCopy={(row) =>
                access.copy(`127.0.0.1:${row.localPort}`, `forward:${row.localPort}`)
              }
              onEdit={(row) =>
                access.edit({
                  kind: 'forward',
                  originalPort: row.localPort,
                  connectionInfo: formatAccessConnectionInfo(row.providerId, row.remotePort),
                  localPort: String(row.localPort),
                  enabled: row.enabled
                })
              }
              onToggle={(row) =>
                void toggle('forward', row.localPort, row.phase === 'failed' || !row.enabled)
              }
              onRemove={(row) => void remove('forward', row.localPort)}
              onDetails={(row) => setSelectedDetail({ kind: 'forward', localPort: row.localPort })}
            />
          )}
        </section>
      )}
      {access.settingsOpen && (
        <AccessSettings
          connection={access.connection}
          busy={access.busy}
          loadError={access.loadError}
          error={access.errorTarget === 'settings' ? access.error : ''}
          onChange={access.patchConnection}
          onReload={access.reload}
          onSave={access.saveConnection}
          onClose={access.closeSettings}
        />
      )}
      {access.editor && (
        <TunnelPortEditor
          draft={access.editor}
          busy={access.busy}
          error={access.errorTarget === 'editor' ? access.error : ''}
          onChange={access.edit}
          onSave={savePort}
          onCancel={() => access.edit(null)}
        />
      )}
      {detail && (
        <AccessDetails
          detail={detail}
          connections={tunnel?.connections ?? []}
          connectionInfo={
            detail.kind === 'publication'
              ? connectionInfo(detail.row.localPort) || null
              : formatAccessConnectionInfo(detail.row.providerId, detail.row.remotePort)
          }
          busy={access.busy}
          copied={access.copied}
          error={access.errorTarget === 'details' ? access.error : ''}
          onCopy={(value) => access.copy(value, 'details')}
          onClose={() => setSelectedDetail(null)}
        />
      )}
    </main>
  )
}
