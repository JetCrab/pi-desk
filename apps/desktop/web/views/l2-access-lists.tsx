import type {
  ForwardSnapshot,
  PublicationSnapshot,
  TunnelPath,
  TunnelPhase
} from '../l4-desktop-ipc'
import { DesktopIcon, DesktopMenu } from '../l4-desktop-ui'

export const accessPhases: Record<TunnelPhase, string> = {
  stopped: '已停止',
  opening: '正在开启',
  connecting: '正在连接',
  listening: '已就绪',
  recovering: '正在恢复',
  stopping: '正在停止',
  failed: '连接失败'
}
export const accessPaths: Record<TunnelPath, string> = {
  unknown: '路径待确认',
  direct: '直连',
  relay: '中继'
}

type ListActions<Row> = {
  busy: boolean
  copied: string
  errorFor: (localPort: number) => string
  onCopy: (row: Row) => void
  onEdit: (row: Row) => void
  onToggle: (row: Row) => void
  onRemove: (row: Row) => void
  onDetails: (row: Row) => void
}

export function PublicationList({
  rows,
  selectedPort,
  providerReady,
  busy,
  copied,
  connectionInfo,
  publicUrl,
  errorFor,
  onCopy,
  onCopyPublic,
  onOpenPublic,
  onEdit,
  onToggle,
  onRemove,
  onDetails
}: ListActions<PublicationSnapshot> & {
  rows: readonly PublicationSnapshot[]
  selectedPort: number | null
  providerReady: boolean
  connectionInfo: (row: PublicationSnapshot) => string
  publicUrl: (row: PublicationSnapshot) => string | null
  onCopyPublic: (row: PublicationSnapshot) => void
  onOpenPublic: (row: PublicationSnapshot) => void
}): React.JSX.Element {
  return (
    <div className="access-list">
      {!rows.length && <p className="access-empty">还没有共享端口</p>}
      {rows.map((row) => {
        const url = publicUrl(row)
        const error = errorFor(row.localPort) || (row.phase === 'failed' ? row.detail : '')
        return (
          <article
            key={row.localPort}
            className="access-row"
            data-selected={row.localPort === selectedPort}
            aria-label={`本机共享 ${row.localPort}`}
          >
            <div className="access-row-main">
              <span className="access-row-icon">
                <DesktopIcon name="monitor" />
              </span>
              <div className="access-row-info">
                <h2>
                  本机端口 <span className="access-port">{row.localPort}</span>
                </h2>
                <p className="access-row-meta">
                  <span className={row.phase === 'listening' ? 'good' : undefined}>
                    {row.phase === 'listening' ? '共享中' : accessPhases[row.phase]}
                  </span>
                  <span>
                    {row.publicPort === null ? '仅客户端访问' : `公网端口 ${row.publicPort}`}
                  </span>
                </p>
              </div>
              <div className="access-row-actions">
                <button type="button" disabled={busy || !providerReady} onClick={() => onCopy(row)}>
                  <DesktopIcon name="copy" />
                  {providerReady && copied === connectionInfo(row) ? '已复制' : '复制连接信息'}
                </button>
                <DesktopMenu label={`本机端口 ${row.localPort} 的更多操作`}>
                  <button
                    type="button"
                    disabled={busy || row.phase === 'stopping'}
                    onClick={() => onToggle(row)}
                  >
                    {row.phase === 'failed' && row.enabled
                      ? '重试共享'
                      : row.enabled
                        ? '停止共享'
                        : '开始共享'}
                  </button>
                  <button type="button" disabled={busy} onClick={() => onEdit(row)}>
                    <DesktopIcon name="edit" />
                    编辑
                  </button>
                  <hr />
                  <button
                    className="danger"
                    type="button"
                    disabled={busy}
                    onClick={() => onRemove(row)}
                  >
                    <DesktopIcon name="trash" />
                    删除
                  </button>
                </DesktopMenu>
              </div>
            </div>
            <div className="access-row-secondary">
              <button
                className="quiet"
                type="button"
                disabled={busy}
                onClick={() => onDetails(row)}
              >
                连接详情
              </button>
              {row.publicAddr && (
                <>
                  {url && (
                    <button
                      className="quiet"
                      type="button"
                      disabled={busy}
                      onClick={() => onOpenPublic(row)}
                    >
                      <DesktopIcon name="globe" />
                      打开网页
                    </button>
                  )}
                  <button
                    className="quiet"
                    type="button"
                    disabled={busy}
                    onClick={() => onCopyPublic(row)}
                  >
                    {copied === (url ?? row.publicAddr)
                      ? '已复制'
                      : url
                        ? '复制公网链接'
                        : '复制公网地址'}
                  </button>
                </>
              )}
            </div>
            {error && (
              <p className="page-error" role="alert">
                {error}
              </p>
            )}
          </article>
        )
      })}
    </div>
  )
}

export function ForwardList({
  rows,
  busy,
  copied,
  errorFor,
  onCopy,
  onEdit,
  onToggle,
  onRemove,
  onDetails
}: ListActions<ForwardSnapshot> & { rows: readonly ForwardSnapshot[] }): React.JSX.Element {
  return (
    <div className="access-list">
      {!rows.length && <p className="access-empty">粘贴连接信息，即可连接远端端口。</p>}
      {rows.map((row) => {
        const error = errorFor(row.localPort) || (row.phase === 'failed' ? row.detail : '')
        return (
          <article
            key={row.localPort}
            className="access-row"
            aria-label={`远端连接 ${row.localPort}`}
          >
            <div className="access-row-main">
              <span className="access-row-icon">
                <DesktopIcon name="globe" />
              </span>
              <div className="access-row-info">
                <h2 className="access-port-route">
                  <span>
                    本地 <span className="access-port">{row.localPort}</span>
                  </span>
                  <DesktopIcon name="arrow" />
                  <span>
                    远端 <span className="access-port">{row.remotePort}</span>
                  </span>
                </h2>
                <p className="access-row-meta">
                  {row.phase === 'listening' ? (
                    <span className={row.path !== 'unknown' ? 'good' : undefined}>
                      {row.path === 'unknown' ? '本地已就绪 · 路径待确认' : accessPaths[row.path]}
                    </span>
                  ) : (
                    accessPhases[row.phase]
                  )}
                </p>
              </div>
              <div className="access-row-actions">
                <button type="button" disabled={busy} onClick={() => onCopy(row)}>
                  <DesktopIcon name="copy" />
                  {copied === `127.0.0.1:${row.localPort}` ? '已复制' : '复制本地地址'}
                </button>
                <DesktopMenu label={`本地端口 ${row.localPort} 的更多操作`}>
                  <button
                    type="button"
                    disabled={busy || row.phase === 'stopping'}
                    onClick={() => onToggle(row)}
                  >
                    {row.phase === 'failed' && row.enabled
                      ? '重新连接'
                      : row.enabled
                        ? '断开连接'
                        : '连接'}
                  </button>
                  <button type="button" disabled={busy} onClick={() => onEdit(row)}>
                    <DesktopIcon name="edit" />
                    编辑
                  </button>
                  <button type="button" disabled={busy} onClick={() => onDetails(row)}>
                    连接详情
                  </button>
                  <hr />
                  <button
                    className="danger"
                    type="button"
                    disabled={busy}
                    onClick={() => onRemove(row)}
                  >
                    <DesktopIcon name="trash" />
                    移除
                  </button>
                </DesktopMenu>
              </div>
            </div>
            {error && (
              <p className="page-error" role="alert">
                {error}
              </p>
            )}
          </article>
        )
      })}
    </div>
  )
}
