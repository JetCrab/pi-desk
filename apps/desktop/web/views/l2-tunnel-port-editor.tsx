import { useState } from 'react'
import { parseAccessConnectionInfo, type PortDraft } from '../l2-access-biz'
import { AccessDialog } from './l2-access-dialog'

function targetPort(value: string): number | null {
  try {
    return parseAccessConnectionInfo(value).remotePort
  } catch {
    return null
  }
}

export function TunnelPortEditor({
  draft,
  busy,
  error,
  onChange,
  onSave,
  onCancel
}: {
  draft: PortDraft
  busy: boolean
  error: string
  onChange: (draft: PortDraft) => void
  onSave: () => Promise<void>
  onCancel: () => void
}): React.JSX.Element {
  const [publicEnabled, setPublicEnabled] = useState(
    draft.kind === 'publication' && Boolean(draft.publicPort)
  )
  const [connectionError, setConnectionError] = useState('')
  const remotePort = draft.kind === 'forward' ? targetPort(draft.connectionInfo) : null
  const editing = draft.originalPort !== null
  return (
    <AccessDialog
      title={`${editing ? '编辑' : '添加'}${draft.kind === 'publication' ? '本机共享' : '远端连接'}`}
      busy={busy}
      onClose={onCancel}
    >
      <form
        className="access-editor"
        onSubmit={(event) => {
          event.preventDefault()
          if (draft.kind === 'forward') {
            try {
              parseAccessConnectionInfo(draft.connectionInfo)
            } catch (cause) {
              setConnectionError(cause instanceof Error ? cause.message : String(cause))
              return
            }
          }
          void onSave()
        }}
      >
        {draft.kind === 'forward' && (
          <label className="field">
            连接信息
            <textarea
              required
              rows={3}
              spellCheck={false}
              autoComplete="off"
              placeholder="粘贴 pidesk-tcp://… 连接信息"
              value={draft.connectionInfo}
              disabled={busy}
              aria-invalid={Boolean(connectionError)}
              onChange={(event) => {
                const value = event.target.value
                const parsedPort = targetPort(value)
                onChange({
                  ...draft,
                  connectionInfo: value,
                  localPort:
                    parsedPort !== null && !draft.localPort ? String(parsedPort) : draft.localPort
                })
                setConnectionError('')
              }}
              onBlur={() => {
                if (!draft.connectionInfo.trim()) return
                try {
                  parseAccessConnectionInfo(draft.connectionInfo)
                } catch (cause) {
                  setConnectionError(cause instanceof Error ? cause.message : String(cause))
                }
              }}
            />
            {connectionError ? (
              <span className="access-field-error" role="alert">
                {connectionError}
              </span>
            ) : remotePort !== null ? (
              <span className="hint">目标端口 {remotePort}</span>
            ) : null}
          </label>
        )}
        <label className="field">
          {draft.kind === 'publication' ? '本机端口' : '固定本地端口'}
          <input
            type="number"
            required
            min={1}
            max={65535}
            step={1}
            value={draft.localPort}
            disabled={busy}
            onChange={(event) => onChange({ ...draft, localPort: event.target.value })}
          />
        </label>
        {draft.kind === 'publication' && (
          <>
            <label className="access-public-toggle">
              开启公网访问
              <input
                className="switch"
                type="checkbox"
                role="switch"
                checked={publicEnabled}
                disabled={busy}
                onChange={(event) => {
                  setPublicEnabled(event.target.checked)
                  if (!event.target.checked) onChange({ ...draft, publicPort: '' })
                }}
              />
            </label>
            {publicEnabled && (
              <label className="field">
                公网端口
                <input
                  type="number"
                  required
                  min={1}
                  max={65535}
                  step={1}
                  value={draft.publicPort}
                  disabled={busy}
                  onChange={(event) => onChange({ ...draft, publicPort: event.target.value })}
                />
                <span className="hint">通过公网地址访问，无需安装客户端。</span>
              </label>
            )}
          </>
        )}
        {error && (
          <p className="page-error" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" disabled={busy} onClick={onCancel}>
            取消
          </button>
          <button className="primary" type="submit" disabled={busy}>
            {busy
              ? '正在保存…'
              : editing
                ? '保存'
                : draft.kind === 'publication'
                  ? '开始共享'
                  : '连接'}
          </button>
        </div>
      </form>
    </AccessDialog>
  )
}
