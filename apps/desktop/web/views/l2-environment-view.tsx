import type { EnvironmentComponent, EnvironmentSnapshot, TargetSnapshot } from '../l4-desktop-ipc'
import { DesktopError, DesktopIcon } from '../l4-desktop-ui'

const isWindows = /Windows/u.test(navigator.userAgent)
const componentLabels = {
  node: 'Node.js',
  pi: 'Pi',
  bash: isWindows ? 'Git Bash' : 'Git 和 Bash'
} as const
const componentOrder = ['node', 'bash', 'pi'] as const

export type EnvironmentViewAction =
  | { kind: 'prepare' | 'check' | 'cancel' | 'open' | 'copy-error' | 'copy-command' }
  | { kind: 'options'; open: boolean }
  | { kind: 'select'; component: EnvironmentComponent['name']; archive: boolean }
  | { kind: 'help'; component: EnvironmentComponent['name'] }

function bytes(value: number): string {
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`
  return `${(value / 1024 / 1024).toFixed(1)} MB`
}

function SetupStep({
  label,
  ready,
  active,
  detail,
  download,
  failed = false
}: {
  label: string
  ready: boolean
  active: boolean
  detail: string
  download?: EnvironmentComponent['download']
  failed?: boolean
}): React.JSX.Element {
  const percent = download?.total
    ? Math.min(100, Math.round((download.received / download.total) * 100))
    : undefined
  return (
    <li className="setup-step" data-active={active} data-ready={ready} data-failed={failed}>
      <div className="step-heading">
        <span className={`component-icon${ready ? ' good' : failed ? ' invalid' : ''}`}>
          {ready || active || failed ? (
            <DesktopIcon name={ready ? 'check' : failed ? 'alert' : 'loader'} spinning={active} />
          ) : (
            <span className="step-dot" />
          )}
        </span>
        <strong>{label}</strong>
      </div>
      <p className="step-state">{detail}</p>
      <div className="step-progress">
        {active && !download ? (
          <progress aria-label={`${label}安装进度`} />
        ) : (
          <progress
            aria-label={`${label}下载进度`}
            max={100}
            value={ready ? 100 : download ? percent : 0}
          />
        )}
      </div>
      {download && (
        <p className="step-bytes">
          <span>
            {bytes(download.received)}
            {download.total ? ` / ${bytes(download.total)}` : ''}
          </span>
          {percent !== undefined && <span>{percent}%</span>}
        </p>
      )}
    </li>
  )
}

export type EnvironmentViewProps = {
  environment: EnvironmentSnapshot
  target: TargetSnapshot
  optionsOpen: boolean
  mode: 'prepare' | 'options'
  onDownloadSettings: () => void
  installCommand: string
  launching: boolean
  busy: boolean
  cancelling: boolean
  error: string
  copied: string
  copyHint: string
  onAction: (action: EnvironmentViewAction) => void
}

export function EnvironmentView({
  environment,
  target,
  optionsOpen,
  mode,
  onDownloadSettings,
  installCommand,
  launching,
  busy,
  cancelling,
  error,
  copied,
  copyHint,
  onAction
}: EnvironmentViewProps): React.JSX.Element {
  const installing = environment.status === 'installing'
  const checking = environment.status === 'checking'
  const starting = target.server?.status === 'starting'
  const working = installing || starting || launching
  const locked = busy || working || checking
  const optionsOnly = mode === 'options'
  const failure =
    error ||
    environment.error ||
    (!optionsOnly && target.server?.status === 'failed' ? target.server.detail : '')
  const canOpen = !target.server?.needsSetup && !checking
  const components = componentOrder.flatMap((name) =>
    environment.components.filter((item) => item.name === name)
  )
  const update = target.server?.update
  const packageReady = update?.status === 'installed' || Boolean(target.server?.version)
  const packageActive = working && ['checking', 'installing'].includes(update?.status ?? '')
  const packageDetail =
    update?.status === 'checking'
      ? '正在查询版本'
      : update?.status === 'installing'
        ? `正在下载安装${update.version ? ` ${update.version}` : ''}`
        : update?.status === 'failed'
          ? '安装失败'
          : packageReady
            ? '已安装'
            : working
              ? '等待 Node.js 就绪'
              : '待安装'
  const downloadSettings = (
    <button
      type="button"
      className="quiet link-button"
      data-testid="environment-download-settings"
      disabled={locked}
      onClick={onDownloadSettings}
    >
      下载设置
    </button>
  )

  return (
    <section className="environment-panel" aria-label="本机安装" data-options-only={optionsOnly}>
      {!optionsOnly && (
        <>
          <div className="setup-caption" role="status">
            <h3>
              {checking
                ? '正在检查所需组件'
                : working
                  ? '正在准备 Pi Desk'
                  : failure
                    ? '准备未完成'
                    : '首次使用准备'}
            </h3>
            {working && <span className="muted">完成后自动打开</span>}
          </div>
          <ol className="setup-steps" aria-label="安装步骤">
            {components.map((component) => {
              const ready = component.status === 'ready' && !component.detail
              const active = installing && !ready && Boolean(component.detail?.startsWith('正在'))
              return (
                <SetupStep
                  key={component.name}
                  label={componentLabels[component.name]}
                  ready={ready}
                  active={active}
                  failed={component.status === 'invalid'}
                  download={active ? component.download : null}
                  detail={
                    ready
                      ? '已安装'
                      : component.detail ||
                        (checking ? '正在检测' : working ? '等待安装' : '待安装')
                  }
                />
              )
            })}
            <SetupStep
              label="Pi Desk"
              ready={packageReady && !packageActive}
              active={packageActive}
              detail={packageDetail}
              failed={update?.status === 'failed'}
            />
          </ol>
          {working && components.every((item) => item.status === 'ready') && !packageActive && (
            <p className="setup-status" role="status">
              <DesktopIcon name="loader" spinning />
              {target.server?.status === 'running'
                ? '正在打开 Pi Desk…'
                : '正在校验并启动 Pi Desk…'}
            </p>
          )}
        </>
      )}
      {failure && (
        <DesktopError
          title="安装未完成"
          detail={failure}
          expanded
          onCopy={() => onAction({ kind: 'copy-error' })}
          copied={copied === 'error'}
        />
      )}
      {!optionsOnly && (
        <div className="setup-footer">
          {!working && downloadSettings}
          <div className="actions setup-actions">
            {working ? (
              <button
                type="button"
                className="quiet"
                disabled={cancelling || launching}
                onClick={() => onAction({ kind: 'cancel' })}
              >
                {cancelling ? '正在取消…' : '取消安装'}
              </button>
            ) : (
              <button
                className="primary forward"
                type="button"
                disabled={locked}
                onClick={() => onAction({ kind: canOpen ? 'open' : 'prepare' })}
              >
                {checking
                  ? '请稍候…'
                  : canOpen
                    ? '打开 Pi Desk'
                    : failure
                      ? '重试安装'
                      : '安装并打开'}
                {!checking && <DesktopIcon name="arrow" />}
              </button>
            )}
          </div>
        </div>
      )}
      {!working && (
        <details
          className="disclosure install-options"
          open={optionsOpen}
          onToggle={(event) => {
            if (event.currentTarget.open !== optionsOpen)
              onAction({ kind: 'options', open: event.currentTarget.open })
          }}
        >
          <summary>
            <DesktopIcon name="chevron" />
            安装选项
          </summary>
          <div className="details-body">
            {optionsOnly && downloadSettings}
            <div className="components">
              {components.map((component) => (
                <details className="component" name="environment-component" key={component.name}>
                  <summary>
                    <span className="grow">
                      {componentLabels[component.name]}
                      <span className="muted component-version">{component.version}</span>
                    </span>
                    <DesktopIcon name="chevron" />
                  </summary>
                  <div className="component-body">
                    {component.status === 'invalid' && component.detail && (
                      <p className="component-problem">{component.detail}</p>
                    )}
                    {component.path && <p className="path-text">{component.path}</p>}
                    {component.name === 'pi' && installCommand && (
                      <p className="code-line">{installCommand}</p>
                    )}
                    <div className="actions">
                      {component.name === 'pi' ? (
                        <button
                          type="button"
                          disabled={locked || !installCommand}
                          onClick={() => onAction({ kind: 'copy-command' })}
                        >
                          <DesktopIcon name="copy" />
                          {copied === 'command' ? '已复制' : '复制安装命令'}
                        </button>
                      ) : (
                        <button
                          className="quiet link-button"
                          type="button"
                          disabled={locked}
                          onClick={() => onAction({ kind: 'help', component: component.name })}
                        >
                          打开官方下载页
                          <DesktopIcon name="arrow" />
                        </button>
                      )}
                      <button
                        type="button"
                        disabled={locked}
                        onClick={() =>
                          onAction({ kind: 'select', component: component.name, archive: false })
                        }
                      >
                        <DesktopIcon name="folder" />
                        选择已安装的位置
                      </button>
                      {component.name === 'node' && isWindows && (
                        <button
                          className="quiet"
                          type="button"
                          disabled={locked}
                          onClick={() =>
                            onAction({ kind: 'select', component: 'node', archive: true })
                          }
                        >
                          选择已下载的安装包
                        </button>
                      )}
                    </div>
                  </div>
                </details>
              ))}
            </div>
            <div className="actions">
              <button type="button" disabled={locked} onClick={() => onAction({ kind: 'check' })}>
                <DesktopIcon name="refresh" />
                重新检测
              </button>
            </div>
          </div>
        </details>
      )}
      {copyHint && (
        <p className="muted" role="status">
          {copyHint}
        </p>
      )}
    </section>
  )
}
