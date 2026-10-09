import { useState, type FormEvent } from 'react'
import { useAccess } from './hooks/l2-use-access'
import type { TargetSnapshot } from './l4-desktop-ipc'
import { DesktopHeader, DesktopIcon } from './l4-desktop-ui'

export function AccessPage({
  url,
  target,
  refresh,
  onDirty,
  onBack
}: {
  url: string
  target: TargetSnapshot | undefined
  refresh: () => void
  onDirty: (dirty: boolean) => void
  onBack: () => void
}): React.JSX.Element {
  const access = useAccess(url, refresh, onDirty)
  const [editing, setEditing] = useState(!target?.tunnel)
  const tunnel = target?.tunnel
  const connecting = Boolean(
    tunnel && ['opening', 'connecting', 'recovering', 'stopping'].includes(tunnel.status)
  )
  const listening = tunnel?.status === 'listening'
  const source = new URL(url)
  const address =
    listening && tunnel.publicAddr
      ? `${source.protocol}//${tunnel.publicAddr}${source.pathname}${source.search}${source.hash}`
      : ''
  const needsSetup = Boolean(target?.server?.needsSetup)
  const error = access.error || (tunnel?.status === 'failed' ? tunnel.detail : '')
  const status = listening
    ? '已开启'
    : tunnel?.status === 'stopping'
      ? '正在关闭访问…'
      : connecting
        ? '正在连接…'
        : tunnel?.status === 'failed'
          ? '连接失败'
          : tunnel
            ? '未开启'
            : '尚未配置中转服务'
  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    if (listening && !window.confirm('修改配置会重新连接，其他设备的访问将暂时中断。确定继续吗？'))
      return
    if (await access.save()) setEditing(false)
  }
  return (
    <main className="desktop-settings access-page">
      <DesktopHeader />
      <div className="page-heading">
        <button
          className="icon-button"
          type="button"
          aria-label="返回"
          disabled={access.busy}
          onClick={onBack}
        >
          <DesktopIcon name="back" />
        </button>
        <h1>远程访问</h1>
      </div>
      <section className="access-overview" aria-label="远程访问状态">
        <div className="panel-heading">
          <h2>连接这台电脑</h2>
          <span className={listening ? 'status-line good' : 'status-line'} role="status">
            {connecting ? <DesktopIcon name="loader" spinning /> : <span className="dot" />}
            {status}
          </span>
        </div>
        {address && (
          <div className="access-address">
            <p className="path-text">{address}</p>
            <button type="button" disabled={access.busy} onClick={() => access.copy(address)}>
              <DesktopIcon name="copy" />
              {access.copied ? '已复制' : '复制地址'}
            </button>
          </div>
        )}
        {needsSetup && <p className="muted">本机组件准备完成后可开启访问</p>}
        {!editing && tunnel && (
          <div className="actions">
            {tunnel.status === 'stopped' || tunnel.status === 'failed' ? (
              <button
                className="primary"
                type="button"
                disabled={access.busy || needsSetup}
                onClick={access.start}
              >
                {tunnel.status === 'failed' ? '重新连接' : '开启访问'}
              </button>
            ) : (
              <button
                type="button"
                disabled={access.busy || tunnel.status === 'stopping'}
                onClick={access.stop}
              >
                关闭访问
              </button>
            )}
            <button
              className="quiet"
              type="button"
              disabled={access.busy || connecting}
              onClick={() => setEditing(true)}
            >
              修改配置
            </button>
          </div>
        )}
      </section>
      {access.loadError && (
        <div className="page-error" role="alert">
          <p>{access.loadError}</p>
          <button type="button" onClick={access.reload}>
            重新读取
          </button>
        </div>
      )}
      {error && (
        <p className="page-error" role="alert">
          {error}
        </p>
      )}
      {editing && !access.draft && !access.loadError && (
        <p className="loading" role="status">
          <DesktopIcon name="loader" spinning />
          正在读取设置…
        </p>
      )}
      {editing && access.draft && !access.loadError && (
        <form onSubmit={(event) => void submit(event)} aria-label="远程访问配置">
          <h2>你的中转服务</h2>
          <label className="field">
            中转服务地址
            <input
              type="url"
              required
              autoComplete="off"
              placeholder="https://tunnel.example.com"
              disabled={access.busy}
              value={access.draft.controlServerUrl}
              onChange={(event) => access.patch({ controlServerUrl: event.target.value })}
            />
          </label>
          <label className="field">
            连接密钥
            <input
              type="password"
              required
              autoComplete="off"
              spellCheck={false}
              disabled={access.busy}
              value={access.draft.controlKey}
              onChange={(event) => access.patch({ controlKey: event.target.value })}
            />
          </label>
          <label className="field">
            访问端口
            <input
              type="number"
              required
              min={1}
              max={65535}
              step={1}
              inputMode="numeric"
              placeholder="例如 40333"
              disabled={access.busy}
              value={access.draft.publicPort}
              onChange={(event) => access.patch({ publicPort: event.target.value })}
            />
          </label>
          <div className="page-actions">
            <button className="quiet" type="button" disabled={access.busy} onClick={onBack}>
              取消
            </button>
            <button className="primary" type="submit" disabled={access.busy || needsSetup}>
              {access.busy ? '正在保存并连接…' : '保存并开启'}
            </button>
          </div>
        </form>
      )}
    </main>
  )
}
