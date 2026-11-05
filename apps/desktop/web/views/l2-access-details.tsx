import type { ForwardSnapshot, PublicationSnapshot, TunnelConnectionRow } from '../l4-desktop-ipc'
import { AccessDialog } from './l2-access-dialog'
import { accessPaths, accessPhases } from './l2-access-lists'

export type AccessDetail =
  { kind: 'publication'; row: PublicationSnapshot } | { kind: 'forward'; row: ForwardSnapshot }

export function AccessDetails({
  detail,
  connections,
  connectionInfo,
  busy,
  copied,
  error,
  onCopy,
  onClose
}: {
  detail: AccessDetail
  connections: readonly TunnelConnectionRow[]
  connectionInfo: string | null
  busy: boolean
  copied: string
  error: string
  onCopy: (value: string) => void
  onClose: () => void
}): React.JSX.Element {
  const { row } = detail
  const active = connections.filter(
    (item) => item.localPort === row.localPort && item.activeTcp > 0
  )
  const address = `127.0.0.1:${row.localPort}`
  return (
    <AccessDialog title="连接详情" busy={busy} onClose={onClose}>
      <dl className="access-detail-fields">
        <div>
          <dt>本地地址</dt>
          <dd>
            <code>{address}</code>
          </dd>
        </div>
        <div>
          <dt>状态</dt>
          <dd>{accessPhases[row.phase]}</dd>
        </div>
        {detail.kind === 'publication' ? (
          <>
            <div>
              <dt>公网地址</dt>
              <dd>
                <code>
                  {detail.row.publicAddr ??
                    (detail.row.publicPort === null ? '未开启公网访问' : '暂无可用地址')}
                </code>
              </dd>
            </div>
            <div>
              <dt>活动 TCP 连接</dt>
              <dd>{active.reduce((total, item) => total + item.activeTcp, 0)}</dd>
            </div>
          </>
        ) : (
          <>
            <div>
              <dt>远端端口</dt>
              <dd>{detail.row.remotePort}</dd>
            </div>
            <div>
              <dt>实际路径</dt>
              <dd>
                {detail.row.phase === 'listening' ? accessPaths[detail.row.path] : '尚未连接'}
              </dd>
            </div>
          </>
        )}
      </dl>
      {detail.kind === 'publication' && active.length > 0 && (
        <ul className="access-active-connections" aria-label="活动连接">
          {active.map((item) => (
            <li key={`${item.peerId}:${item.source}:${item.path}`}>
              {item.source === 'public' ? '公网转发' : `客户端${accessPaths[item.path]}`} ·{' '}
              {item.activeTcp} 条 TCP
            </li>
          ))}
        </ul>
      )}
      {connectionInfo && (
        <details className="access-connection-info">
          <summary>连接信息</summary>
          <code>{connectionInfo}</code>
        </details>
      )}
      {(error || row.detail) && (
        <p
          className={error || row.phase === 'failed' ? 'page-error' : 'muted'}
          role={error || row.phase === 'failed' ? 'alert' : undefined}
        >
          {error || row.detail}
        </p>
      )}
      <div className="dialog-actions">
        <button type="button" disabled={busy} onClick={onClose}>
          关闭
        </button>
        <button
          className="primary"
          type="button"
          disabled={busy || (detail.kind === 'publication' && !connectionInfo)}
          onClick={() => {
            const value = detail.kind === 'publication' ? connectionInfo : address
            if (value) onCopy(value)
          }}
        >
          {copied === (detail.kind === 'publication' ? connectionInfo : address)
            ? '已复制'
            : detail.kind === 'publication'
              ? '复制连接信息'
              : '复制本地地址'}
        </button>
      </div>
    </AccessDialog>
  )
}
