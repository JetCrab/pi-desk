import type { EnvironmentSnapshot } from '../l4-desktop-ipc'
import { DesktopError, DesktopIcon } from '../l4-desktop-ui'

export type PiUpdateViewProps = {
  environment: EnvironmentSnapshot
  checking: boolean
  updating: boolean
  cancelling: boolean
  error: string
  copied: boolean
  copyHint: string
  onCheck: () => void
  onUpdate: () => void
  onCancel: () => void
  onCopy: () => void
}

export function PiUpdateView({
  environment,
  checking,
  updating,
  cancelling,
  error,
  copied,
  copyHint,
  onCheck,
  onUpdate,
  onCancel,
  onCopy
}: PiUpdateViewProps): React.JSX.Element {
  const pi = environment.components.find((component) => component.name === 'pi')
  const available = environment.piUpdate.status === 'available'
  const locked = checking || updating || ['checking', 'installing'].includes(environment.status)
  return (
    <section className="environment-panel" aria-label="Pi 更新">
      <div className="panel-heading">
        <div>
          <h3>Pi 本体</h3>
          <div className="pi-version muted">
            <p>{pi?.version ? `当前版本 ${pi.version}` : '尚未检测到 Pi 版本'}</p>
            {updating && (
              <span
                className="pi-update-status"
                role="status"
                title="校验通过后仅恢复原先运行的服务；聊天和任务不会自动续跑。"
              >
                <DesktopIcon name="loader" spinning />
                {environment.status === 'installing'
                  ? environment.step || '正在更新 Pi…'
                  : '正在核对 Pi 更新…'}
              </span>
            )}
          </div>
        </div>
        <div className="actions">
          {updating ? (
            <button type="button" disabled={cancelling} onClick={onCancel}>
              {cancelling ? '正在取消…' : '取消 Pi 更新'}
            </button>
          ) : (
            <>
              <button
                type="button"
                disabled={
                  locked ||
                  !pi?.path ||
                  !environment.components.some(
                    (item) => item.name === 'node' && item.status === 'ready'
                  )
                }
                onClick={onCheck}
              >
                <DesktopIcon name={checking ? 'loader' : 'refresh'} spinning={checking} />
                检查 Pi 更新
              </button>
              {available && !error && (
                <button className="primary" type="button" disabled={locked} onClick={onUpdate}>
                  <DesktopIcon name="download" />
                  更新 Pi{environment.piUpdate.version ? ` ${environment.piUpdate.version}` : ''}
                </button>
              )}
            </>
          )}
        </div>
      </div>
      {!updating &&
        (checking ? (
          <p className="muted" role="status">
            正在查询 latest 稳定版，不会安装或停止服务。
          </p>
        ) : environment.piUpdate.status === 'current' && !error ? (
          <p className="muted" role="status">
            未发现更新的 Pi 正式版本。
          </p>
        ) : null)}
      {error && (
        <DesktopError
          title="Pi 更新操作未完成"
          detail={error}
          expanded
          onCopy={onCopy}
          copied={copied}
        />
      )}
      {copyHint && (
        <p className="muted" role="status">
          {copyHint}
        </p>
      )}
    </section>
  )
}
