import type { TunnelConnection } from '../l4-desktop-ipc'
import { AccessDialog } from './l2-access-dialog'

export function AccessSettings({
  connection,
  busy,
  loadError,
  error,
  onChange,
  onReload,
  onSave,
  onClose
}: {
  connection: TunnelConnection | null
  busy: boolean
  loadError: string
  error: string
  onChange: (value: Partial<TunnelConnection>) => void
  onReload: () => void
  onSave: () => Promise<void>
  onClose: () => void
}): React.JSX.Element {
  return (
    <AccessDialog title="服务器设置" busy={busy} onClose={onClose}>
      {loadError ? (
        <div className="page-error" role="alert">
          <p>{loadError}</p>
          <button type="button" disabled={busy} onClick={onReload}>
            重新读取设置
          </button>
        </div>
      ) : !connection ? (
        <p className="muted" role="status">
          正在读取设置…
        </p>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault()
            void onSave()
          }}
        >
          <label className="field">
            服务器地址
            <input
              type="url"
              required
              autoComplete="off"
              placeholder="http://tunnel.example.com:7001"
              disabled={busy}
              value={connection.controlServerUrl}
              onChange={(event) => onChange({ controlServerUrl: event.target.value })}
            />
          </label>
          <label className="field">
            控制密钥
            <input
              type="password"
              required
              autoComplete="off"
              spellCheck={false}
              disabled={busy}
              value={connection.controlKey}
              onChange={(event) => onChange({ controlKey: event.target.value })}
            />
          </label>
          {error && (
            <p className="page-error" role="alert">
              {error}
            </p>
          )}
          <div className="dialog-actions">
            <button type="button" disabled={busy} onClick={onClose}>
              取消
            </button>
            <button className="primary" type="submit" disabled={busy}>
              {busy ? '正在保存…' : '保存设置'}
            </button>
          </div>
        </form>
      )}
    </AccessDialog>
  )
}
