import { useId, useState, type ReactNode } from 'react'
import { useDesktopAction } from './hooks/l2-use-desktop-action'
import { useAddressEditor } from './hooks/l2-use-address-editor'
import { useEnvironmentSetup } from './hooks/l2-use-environment-setup'
import { copyDesktopText, runDesktopAction, type DesktopAction } from './l2-desktop-biz'
import type { ControlState, TargetSnapshot } from './l4-desktop-ipc'
import {
  DesktopError,
  DesktopExpansion,
  DesktopHeader,
  DesktopIcon,
  DesktopMenu
} from './l4-desktop-ui'
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

function TargetRow({
  target,
  localCount,
  refresh,
  navigate,
  onSetup,
  onEdit,
  checking = false,
  environmentBusy = false,
  preparing = false,
  optionsOpen = false,
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
  preparing?: boolean
  optionsOpen?: boolean
  setupPanel?: ReactNode
  editor?: ReactNode
}): React.JSX.Element {
  const action = useDesktopAction(refresh)
  const packageAction = useDesktopAction(refresh)
  const cancellation = useDesktopAction(refresh)
  const [copied, setCopied] = useState(false)
  const [copyHint, setCopyHint] = useState('')
  const setupId = useId()
  const { server, tunnel, url } = target
  const parsed = new URL(url)
  const title = server
    ? localCount === 1
      ? '这台电脑'
      : `这台电脑 · ${parsed.port || '80'}`
    : parsed.host
  const working = server?.status === 'starting'
  const updating =
    packageAction.busy ||
    ['checking', 'installing', 'switching'].includes(server?.update?.status ?? '')
  const launchLocked =
    action.busy ||
    working ||
    Boolean(server && (checking || environmentBusy)) ||
    (server?.status !== 'running' && updating)
  const locked = launchLocked || updating
  const failure =
    action.error ||
    packageAction.error ||
    cancellation.error ||
    (server?.status === 'failed' ? server.detail : '') ||
    server?.update?.error ||
    ''
  const status = checking
    ? '正在检查组件…'
    : environmentBusy
      ? '正在准备组件'
      : server?.needsSetup
        ? '首次使用，需要准备以下组件'
        : server?.status === 'running'
          ? '已就绪'
          : server?.status === 'starting'
            ? '正在启动'
            : server?.status === 'failed'
              ? '未能启动'
              : '已准备好'
  const run = (command: DesktopAction): void => {
    const commandAction =
      command === 'check-update' || command === 'update' ? packageAction : action
    void commandAction.run(() => runDesktopAction(command, url))
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
    <article
      className={server ? 'target local-target' : 'target remote-target'}
      aria-label={title}
      data-testid={url}
      data-preparing={preparing}
    >
      {editor || (
        <div className="target-heading">
          <span className={server ? 'device-icon' : 'route-icon'}>
            <DesktopIcon name={server ? 'monitor' : 'globe'} />
          </span>
          <div className="grow">
            <h2 className={server ? 'local-title' : 'target-title'}>{title}</h2>
            {server ? (
              <p className={`status-line${server.status === 'running' ? ' good' : ''}`}>
                <span className="dot" />
                {status}
              </p>
            ) : (
              <p className="target-address muted">{url}</p>
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
            {server ? (
              <>
                <button
                  type="button"
                  disabled={locked}
                  onClick={() => navigate(`#/settings/target?url=${encodeURIComponent(url)}`)}
                >
                  <DesktopIcon name="settings" />
                  本机设置
                </button>
                {server.status === 'running' && (
                  <button type="button" disabled={locked} onClick={restart}>
                    <DesktopIcon name="refresh" />
                    重新启动
                  </button>
                )}
                {(server.status === 'running' || server.status === 'starting') && (
                  <button type="button" disabled={action.busy || packageAction.busy} onClick={stop}>
                    <DesktopIcon name="stop" />
                    停止服务
                  </button>
                )}
              </>
            ) : (
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
      {server && !preparing && (
        <div className="actions launch-actions">
          <button
            className="primary forward"
            type="button"
            disabled={launchLocked}
            onClick={() => (server.needsSetup ? onSetup(url) : run('open'))}
          >
            {checking ? (
              '请稍候…'
            ) : working ? (
              <>
                <DesktopIcon name="loader" spinning />
                正在启动…
              </>
            ) : (
              <>
                {server.needsSetup
                  ? '安装并打开'
                  : server.status === 'failed'
                    ? '重试并打开'
                    : '打开 Pi Desk'}
                <DesktopIcon name="arrow" />
              </>
            )}
          </button>
          {working && server.update?.status !== 'switching' && (
            <button
              className="quiet"
              type="button"
              disabled={cancellation.busy}
              onClick={() => void cancellation.run(() => runDesktopAction('stop', url))}
            >
              {cancellation.busy ? '正在取消…' : '取消'}
            </button>
          )}
        </div>
      )}
      {!preparing &&
        server?.update &&
        (updating || (server.update.status === 'available' && !optionsOpen)) && (
          <div className="update-state" role="status">
            <span>
              {updating ? <DesktopIcon name="loader" spinning /> : null}
              {server.update.status === 'installing'
                ? '正在安装更新'
                : server.update.status === 'switching'
                  ? '正在切换版本'
                  : updating
                    ? '正在检查更新'
                    : '有可用更新'}
              {server.update.version ? ` · ${server.update.version}` : ''}
            </span>
            {server.update.status === 'available' && (
              <button type="button" disabled={locked} onClick={() => run('update')}>
                安装更新
              </button>
            )}
            {updating && !working && server.update.status !== 'switching' && (
              <button
                type="button"
                disabled={cancellation.busy}
                onClick={() => void cancellation.run(() => runDesktopAction('cancel-update', url))}
              >
                {cancellation.busy ? '正在取消…' : '取消更新'}
              </button>
            )}
          </div>
        )}
      {failure && !preparing && (
        <>
          <DesktopError
            title={server?.status === 'failed' ? '暂时无法打开 Pi Desk' : '操作未完成'}
            detail={failure}
            onCopy={() => void copyError()}
            copied={copied}
            expanded
          />
          {copyHint && (
            <p className="muted" role="status">
              {copyHint}
            </p>
          )}
        </>
      )}
      {(server || tunnel) && (
        <div className="target-tools">
          <button
            className="quiet forward"
            type="button"
            aria-label="在其他设备上使用"
            onClick={() => navigate(`#/access?url=${encodeURIComponent(url)}`)}
          >
            <DesktopIcon name="globe" />
            在其他设备上使用
            {tunnel?.status === 'listening' && (
              <span className="connection-badge good">已开启</span>
            )}
            {tunnel?.status === 'failed' && (
              <span className="connection-badge connection-problem">连接失败</span>
            )}
            <DesktopIcon name="arrow" />
          </button>
          {server && !preparing && (
            <button
              className="quiet"
              type="button"
              aria-expanded={optionsOpen}
              aria-controls={setupId}
              onClick={() => onSetup(url)}
            >
              <DesktopIcon name="download" />
              安装与版本
              <DesktopIcon name="chevron" />
            </button>
          )}
        </div>
      )}
      {server && (
        <DesktopExpansion id={setupId} open={preparing || optionsOpen}>
          <div className="target-panel">
            {optionsOpen && !preparing && (
              <div className="panel-heading">
                <div>
                  <h3>安装与版本</h3>
                  <p className="muted">
                    {server.version ? `Pi Desk ${server.version}` : '尚未安装 Pi Desk'}
                  </p>
                </div>
                {server.update && (
                  <button
                    type="button"
                    disabled={locked || server.needsSetup}
                    onClick={() =>
                      run(server.update?.status === 'available' ? 'update' : 'check-update')
                    }
                  >
                    <DesktopIcon name="download" />
                    {server.update.status === 'available'
                      ? `安装更新${server.update.version ? ` ${server.update.version}` : ''}`
                      : '检查更新'}
                  </button>
                )}
              </div>
            )}
            {setupPanel}
          </div>
        </DesktopExpansion>
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
  const setup = useEnvironmentSetup(state, refresh)
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
      <DesktopHeader />
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
        <div className="control-loading" role="status" aria-label="正在准备 Pi Desk">
          <span className="device-icon">
            <DesktopIcon name="monitor" />
          </span>
          <div className="loading-caption">
            <DesktopIcon name="loader" spinning />
            正在准备 Pi Desk…
          </div>
        </div>
      )}
      {state && (
        <div className="control-content">
          {local.length > 0 && (
            <div className="local-targets">
              {local.map((target) => {
                const preparing = Boolean(
                  setup.activeUrl === target.url ||
                  (target.server?.status === 'starting' &&
                    !target.server.version &&
                    Boolean(target.server.update)) ||
                  (state.environment.status !== 'checking' && target.server?.needsSetup) ||
                  (['installing', 'failed'].includes(state.environment.status) &&
                    target.url === (setup.activeUrl ?? local[0]?.url))
                )
                return (
                  <TargetRow
                    key={target.url}
                    target={target}
                    localCount={local.length}
                    refresh={refresh}
                    navigate={navigate}
                    onSetup={(url) =>
                      setup.optionsUrl === url
                        ? setup.onAction(target, { kind: 'options', open: false })
                        : setup.showOptions(url)
                    }
                    onEdit={editAddress}
                    checking={state.environment.status === 'checking'}
                    environmentBusy={state.environment.status === 'installing'}
                    optionsOpen={setup.optionsUrl === target.url}
                    preparing={preparing}
                    setupPanel={
                      <EnvironmentView
                        {...setup.view}
                        environment={state.environment}
                        target={target}
                        mode={preparing ? 'prepare' : 'options'}
                        optionsOpen={setup.optionsUrl === target.url}
                        onAction={(input) => setup.onAction(target, input)}
                      />
                    }
                  />
                )
              })}
            </div>
          )}
          {(local.length > 0 || remote.length > 0 || editingUrl === null) && (
            <section className="remote-targets" aria-label="连接另一台电脑">
              <div className="section-heading">
                <h2 className="section-title">连接另一台电脑</h2>
                <button type="button" className="quiet" onClick={() => editAddress(null)}>
                  <DesktopIcon name="plus" />
                  {remote.length ? '添加连接' : '连接其他电脑'}
                </button>
              </div>
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
                连接其他电脑
                <DesktopIcon name="arrow" />
              </button>
            </section>
          )}
        </div>
      )}
    </main>
  )
}
