import { useState, type ReactNode } from 'react'
import { useDesktopAction } from './hooks/l2-use-desktop-action'
import { useAddressEditor } from './hooks/l2-use-address-editor'
import { useEnvironmentSetup } from './hooks/l2-use-environment-setup'
import { copyDesktopText, runDesktopAction, type DesktopAction } from './l2-desktop-biz'
import type { ControlState, TargetSnapshot } from './l4-desktop-ipc'
import { DesktopError, DesktopHeader, DesktopIcon, DesktopMenu } from './l4-desktop-ui'
import { EnvironmentView } from './views/l2-environment-view'
import { AddressEditor } from './views/l2-address-editor'

type PageProps = {
  state: ControlState | null
  readError: string
  openError: string
  dismissOpenError: () => void
  refreshing: boolean
  refresh: () => void
  navigate: (hash: string) => void
  onDirty: (dirty: boolean) => void
}

const updateLabels = {
  idle: '',
  checking: '正在检查更新',
  available: '有可用更新',
  installing: '正在安装',
  switching: '正在重启服务',
  failed: '更新未完成'
} as const

function TargetRow({
  target,
  localCount,
  refresh,
  navigate,
  onSetup,
  onEdit,
  checking = false,
  environmentBusy = false,
  setupPanel,
  editor
}: {
  target: TargetSnapshot
  localCount: number
  refresh: () => void
  navigate: (hash: string) => void
  onSetup: (url: string) => void
  onEdit: (url: string) => void
  checking?: boolean
  environmentBusy?: boolean
  setupPanel?: ReactNode
  editor?: ReactNode
}): React.JSX.Element {
  const action = useDesktopAction(refresh)
  const cancellation = useDesktopAction(refresh)
  const [copied, setCopied] = useState(false)
  const [copyHint, setCopyHint] = useState('')
  const { server, tunnel, url } = target
  const parsed = new URL(url)
  const title = server ? (localCount === 1 ? '这台电脑' : `本机 · ${parsed.port || '80'}`) : url
  const working =
    server?.status === 'starting' ||
    ['checking', 'installing', 'switching'].includes(server?.update?.status ?? '')
  const locked = action.busy || Boolean(working) || Boolean(server && (checking || environmentBusy))
  const failure =
    action.error ||
    cancellation.error ||
    (server?.status === 'failed' ? server.detail : '') ||
    server?.update?.error ||
    (tunnel?.status === 'failed' ? tunnel.detail : '') ||
    ''
  const status = checking
    ? '加载中…'
    : environmentBusy
      ? '正在安装'
      : server?.needsSetup
        ? '需要安装组件'
        : server?.status === 'running'
          ? '已就绪'
          : server?.status === 'starting'
            ? '正在启动'
            : server?.status === 'failed'
              ? '未能启动'
              : '可以启动'
  const run = (command: DesktopAction): void => {
    void action.run(() => runDesktopAction(command, url))
  }
  const copyError = async (): Promise<void> => {
    try {
      await copyDesktopText(`${title}\n${url}\n${failure}`)
      setCopied(true)
      setCopyHint('')
    } catch {
      setCopyHint('当前无法自动复制，请选中问题详情中的文字复制。')
    }
  }
  const stop = (): void => {
    if (
      window.confirm('停止后，这台电脑上运行的聊天和任务将中断，其他设备也会断开连接。确定停止吗？')
    )
      run('stop')
  }
  const restart = (): void => {
    if (window.confirm('重新启动会中断当前运行的任务。确定继续吗？')) run('restart')
  }
  const remove = (): void => {
    if (
      window.confirm(
        `移除这个地址？\n${url}\n${server ? '同时停止此地址的本机服务。' : ''}不会删除聊天记录。`
      )
    )
      run('delete')
  }
  return (
    <article className={server ? 'target local-target' : 'target remote-target'} aria-label={title}>
      {editor || (
        <div className="target-heading">
          {!server && (
            <span className="route-icon">
              <DesktopIcon name="globe" />
            </span>
          )}
          <div className="grow">
            <h2 className={server ? 'local-title' : 'target-title'}>{title}</h2>
            {server && (
              <p className={`status-line${server.status === 'running' ? ' good' : ''}`}>
                <span className="dot" />
                {status}
              </p>
            )}
          </div>
          {!server && (
            <button
              className="quiet forward"
              type="button"
              disabled={locked}
              onClick={() => run('open')}
            >
              打开
              <DesktopIcon name="arrow" />
            </button>
          )}
          <DesktopMenu label={`${title}的更多操作`}>
            {server && (
              <>
                <button
                  type="button"
                  disabled={locked}
                  onClick={() => navigate(`#/settings/target?url=${encodeURIComponent(url)}`)}
                >
                  <DesktopIcon name="settings" />
                  设置
                </button>
                {server.status === 'running' && (
                  <button type="button" disabled={locked} onClick={restart}>
                    <DesktopIcon name="refresh" />
                    重新启动
                  </button>
                )}
                {(server.status === 'running' || server.status === 'starting') && (
                  <button type="button" disabled={action.busy} onClick={stop}>
                    <DesktopIcon name="stop" />
                    停止服务
                  </button>
                )}
                {server.update && (
                  <>
                    <button
                      type="button"
                      disabled={locked || server.needsSetup}
                      onClick={() => run('check-update')}
                    >
                      <DesktopIcon name="download" />
                      检查更新
                    </button>
                    <button
                      type="button"
                      disabled={locked || server.needsSetup}
                      onClick={() => run('update')}
                    >
                      更新到最新
                    </button>
                  </>
                )}
                <button type="button" disabled={locked} onClick={() => onSetup(url)}>
                  安装选项
                </button>
              </>
            )}
            {!server && (
              <button type="button" disabled={locked} onClick={() => onEdit(url)}>
                编辑地址
              </button>
            )}
            <hr />
            <button className="danger" type="button" disabled={locked} onClick={remove}>
              移除地址
            </button>
          </DesktopMenu>
        </div>
      )}
      {setupPanel}
      {server && !setupPanel && (
        <div className="actions launch-actions">
          <button
            className="primary forward"
            type="button"
            disabled={locked}
            onClick={() => (server.needsSetup ? onSetup(url) : run('open'))}
          >
            {checking ? (
              '请稍候…'
            ) : working ? (
              <>
                <DesktopIcon name="loader" spinning />
                {server.update?.status === 'installing'
                  ? '正在安装…'
                  : server.update?.status === 'switching'
                    ? '正在重启…'
                    : server.update?.status === 'checking'
                      ? '正在检查…'
                      : '正在启动…'}
              </>
            ) : (
              <>
                {server.needsSetup
                  ? '安装并打开'
                  : server.status === 'running'
                    ? '打开 Pi Desk'
                    : server.status === 'failed'
                      ? '重试并打开'
                      : '启动并打开'}
                <DesktopIcon name="arrow" />
              </>
            )}
          </button>
          {working && server.update?.status !== 'switching' && (
            <button
              className="quiet"
              type="button"
              disabled={cancellation.busy}
              onClick={() =>
                void cancellation.run(() =>
                  runDesktopAction(server.status === 'starting' ? 'stop' : 'cancel-update', url)
                )
              }
            >
              {cancellation.busy ? '正在取消…' : '取消'}
            </button>
          )}
        </div>
      )}
      {server?.update && server.update.status !== 'idle' && server.update.status !== 'failed' && (
        <div className="update-state" role="status">
          <span>
            {updateLabels[server.update.status]}
            {server.update.version ? ` · ${server.update.version}` : ''}
          </span>
          {server.update.status === 'available' && (
            <button type="button" disabled={locked} onClick={() => run('update')}>
              安装更新
            </button>
          )}
        </div>
      )}
      {failure && !setupPanel && (
        <>
          <DesktopError
            title={server?.status === 'failed' ? '本机服务暂时无法启动' : '操作未完成'}
            detail={failure}
            onCopy={() => void copyError()}
            copied={copied}
          />
          {copyHint && (
            <p className="muted" role="status">
              {copyHint}
            </p>
          )}
        </>
      )}
      {(server || tunnel) && (
        <details className="disclosure target-details">
          <summary>
            <DesktopIcon name="chevron" />
            连接信息{tunnel?.status === 'listening' ? ' · 外部访问已连接' : ''}
          </summary>
          <div className="details-body">
            <p className="path-text">{url}</p>
            {server && (
              <p className="muted">
                {server.version ? `版本 ${server.version} · ` : ''}
                {server.autoStart ? '下次打开桌面版时自动启动' : '已关闭自动启动'}
              </p>
            )}
            {tunnel && (
              <div className="tunnel-state">
                <p>
                  其他设备访问 ·{' '}
                  {tunnel.status === 'listening'
                    ? '已连接'
                    : tunnel.status === 'stopped'
                      ? '未连接'
                      : tunnel.status === 'failed'
                        ? '连接失败'
                        : '正在连接'}
                </p>
                {tunnel.publicAddr && <p className="path-text">{tunnel.publicAddr}</p>}
                {tunnel.status !== 'failed' && tunnel.detail && (
                  <p className="muted">{tunnel.detail}</p>
                )}
                <div className="actions">
                  <button
                    type="button"
                    disabled={locked}
                    onClick={() =>
                      run(
                        tunnel.status === 'stopped' || tunnel.status === 'failed'
                          ? 'start-tunnel'
                          : 'stop-tunnel'
                      )
                    }
                  >
                    {tunnel.status === 'stopped' || tunnel.status === 'failed' ? '连接' : '断开'}
                  </button>
                </div>
              </div>
            )}
          </div>
        </details>
      )}
    </article>
  )
}

function InlineAddressForm({
  originalUrl,
  onDirty,
  onSaved,
  onCancel
}: {
  originalUrl: string | null
  onDirty: (dirty: boolean) => void
  onSaved: (url: string) => void
  onCancel: () => void
}): React.JSX.Element {
  const editor = useAddressEditor(originalUrl, onDirty)
  return (
    <AddressEditor
      {...editor}
      editing={originalUrl !== null}
      onChange={editor.change}
      onSave={() => {
        void editor.save().then((url) => {
          if (url) onSaved(url)
        })
      }}
      onCancel={onCancel}
    />
  )
}

export function ControlPage({
  state,
  readError,
  openError,
  dismissOpenError,
  refreshing,
  refresh,
  navigate,
  onDirty
}: PageProps): React.JSX.Element {
  const [editingUrl, setEditingUrl] = useState<string | null | undefined>(undefined)
  const setup = useEnvironmentSetup(state, refresh, navigate)
  const added = useDesktopAction(refresh)
  const local = state?.targets.filter((target) => target.server) ?? []
  const remote = state?.targets.filter((target) => !target.server) ?? []
  const editAddress = (url: string | null): void => {
    if (editingUrl !== undefined && !window.confirm('放弃当前地址的编辑？')) return
    onDirty(false)
    setEditingUrl(url)
  }
  const editor =
    editingUrl !== undefined ? (
      <InlineAddressForm
        key={editingUrl ?? 'new'}
        originalUrl={editingUrl}
        onDirty={onDirty}
        onCancel={() => {
          onDirty(false)
          setEditingUrl(undefined)
        }}
        onSaved={(url) => {
          const created = editingUrl === null
          setEditingUrl(undefined)
          refresh()
          if (created) void added.run(() => runDesktopAction('open', url))
        }}
      />
    ) : null
  return (
    <main className="desktop-control">
      <DesktopHeader>
        {state && (
          <button type="button" className="quiet" onClick={() => editAddress(null)}>
            <DesktopIcon name="plus" />
            添加地址
          </button>
        )}
        <DesktopMenu label="桌面设置">
          <button type="button" onClick={() => navigate('#/settings/tunnel')}>
            其他设备访问
          </button>
          {local[0] && (
            <button type="button" onClick={() => setup.showOptions(local[0].url)}>
              安装选项
            </button>
          )}
        </DesktopMenu>
      </DesktopHeader>
      {readError && (
        <div className="page-error" role="alert">
          <p>暂时无法读取状态：{readError}</p>
          <button type="button" disabled={refreshing} onClick={refresh}>
            重新连接
          </button>
        </div>
      )}
      {(openError || added.error) && (
        <div className="page-error" role="alert">
          <p>地址已保存，但暂时无法打开：{openError || added.error}</p>
          <button
            className="quiet"
            type="button"
            onClick={() => {
              dismissOpenError()
              added.clearError()
            }}
          >
            关闭提示
          </button>
        </div>
      )}
      {!state && !readError && (
        <div className="loading" role="status">
          <DesktopIcon name="loader" spinning />
          正在读取 Pi Desk…
        </div>
      )}
      {state && (
        <div className="control-content">
          {local.length > 0 && (
            <div className="local-targets">
              {local.map((target) => (
                <TargetRow
                  key={target.url}
                  target={target}
                  localCount={local.length}
                  refresh={refresh}
                  navigate={navigate}
                  onSetup={setup.showOptions}
                  onEdit={editAddress}
                  checking={state.environment.status === 'checking'}
                  environmentBusy={state.environment.status === 'installing'}
                  setupPanel={
                    setup.optionsUrl === target.url ||
                    setup.activeUrl === target.url ||
                    (state.environment.status !== 'checking' && target.server?.needsSetup) ||
                    (['installing', 'failed'].includes(state.environment.status) &&
                      target.url === (setup.activeUrl ?? local[0]?.url)) ? (
                      <EnvironmentView
                        {...setup.view}
                        environment={state.environment}
                        target={target}
                        optionsOpen={setup.optionsUrl === target.url}
                        onAction={(input) => setup.onAction(target, input)}
                      />
                    ) : undefined
                  }
                />
              ))}
            </div>
          )}
          {(remote.length > 0 || editingUrl === null) && (
            <section className="remote-targets">
              <h2 className="section-title">{local.length ? '其他地址' : '我的地址'}</h2>
              {remote.map((target) => (
                <TargetRow
                  key={target.url}
                  target={target}
                  localCount={local.length}
                  refresh={refresh}
                  navigate={navigate}
                  onSetup={setup.showOptions}
                  onEdit={editAddress}
                  editor={editingUrl === target.url ? editor : undefined}
                />
              ))}
              {editingUrl === null && editor}
            </section>
          )}
          {!state.targets.length && editingUrl !== null && (
            <section className="empty">
              <span className="empty-icon">
                <DesktopIcon name="globe" />
              </span>
              <h1>连接你的 Pi Desk</h1>
              <p className="muted">添加电脑或服务器上的地址，即可开始使用。</p>
              <button className="primary forward" type="button" onClick={() => editAddress(null)}>
                添加地址
                <DesktopIcon name="arrow" />
              </button>
            </section>
          )}
        </div>
      )}
    </main>
  )
}
