import type { EnvironmentComponent, EnvironmentSnapshot, TargetSnapshot } from '../l4-desktop-ipc'
import { DesktopError, DesktopIcon } from '../l4-desktop-ui'

const isWindows = /Windows/u.test(navigator.userAgent)
const isMac = /Macintosh|Mac OS X/u.test(navigator.userAgent)
const componentLabels = {
  node: 'Node.js',
  pi: 'Pi',
  bash: isWindows ? 'Git Bash' : 'Git 和 Bash'
} as const
const componentOrder = isMac ? (['bash', 'node', 'pi'] as const) : (['node', 'bash', 'pi'] as const)

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
      {active && (
        <div className="step-progress">
          {download ? (
            <progress aria-label={`${label}下载进度`} max={100} value={percent} />
          ) : (
            <progress aria-label={`${label}安装进度`} />
          )}
        </div>
      )}
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
  piBusy?: boolean
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
  piBusy = false,
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
  const locked = busy || working || checking || piBusy
  const optionsOnly = mode === 'options'
  const failure =
    error ||
    (optionsOnly && environment.piUpdate.status === 'failed' ? '' : environment.error) ||
    (!optionsOnly && target.server?.status === 'failed' ? target.server.detail : '')
  const canOpen = !target.server?.needsSetup && !checking
  const components = componentOrder.flatMap((name) =>
    environment.components.filter((item) => item.name === name)
  )
  const update = target.server?.update
  const packageReady = update?.status === 'installed' || Boolean(target.server?.version)
  const packageActive = working && ['checking', 'installing'].includes(update?.status ?? '')
  const packageDetail = packageActive
    ? '进行中'
    : update?.status === 'failed'
      ? '需要检查'
      : packageReady
        ? '已就绪'
        : working
          ? '等待准备'
          : '待准备'
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
            <h3>{checking ? '正在检查所需组件' : working ? '正在准备 Pi Desk' : '准备 Pi Desk'}</h3>
            <p className="muted setup-description">
              {checking
                ? '正在确认这台电脑需要哪些组件。'
                : working
                  ? environment.step || '组件就绪后会自动打开 Pi Desk。'
                  : failure
                    ? '可重试当前准备，已完成的组件会保留。'
                    : '将准备所需组件，完成后自动打开。已有的可用组件会直接复用。'}
            </p>
          </div>
        </>
      )}
      {failure && (
        <DesktopError
          title="暂时无法继续"
          detail={failure}
          onCopy={() => onAction({ kind: 'copy-error' })}
          copied={copied === 'error'}
        />
      )}
      {!optionsOnly && (
        <>
          <ol className="setup-steps" aria-label="安装步骤">
            {components.map((component) => {
              const ready = component.status === 'ready' && !component.detail
              const active = installing && !ready && Boolean(component.detail?.startsWith('正在'))
              return (
                <SetupStep
                  key={component.name}
                  label={
                    isMac && component.name === 'bash'
                      ? '系统工具'
                      : componentLabels[component.name]
                  }
                  ready={ready}
                  active={active}
                  failed={Boolean(failure) && component.status === 'invalid'}
                  download={active ? component.download : null}
                  detail={
                    ready
                      ? '已就绪'
                      : active
                        ? '进行中'
                        : failure && component.status === 'invalid'
                          ? '需要检查'
                          : checking
                            ? '检测中'
                            : working
                              ? '等待准备'
                              : '待准备'
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
          <div className="setup-footer">
            {working ? (
              <>
                <span className="muted">
                  {cancelling ? '已完成的组件会保留' : '完成后自动打开'}
                </span>
                <button
                  type="button"
                  className="quiet"
                  disabled={cancelling || launching}
                  onClick={() => onAction({ kind: 'cancel' })}
                >
                  {cancelling ? '正在取消…' : '取消准备'}
                </button>
              </>
            ) : (
              <button
                className="primary forward"
                type="button"
                disabled={locked}
                onClick={() => onAction({ kind: canOpen ? 'open' : 'prepare' })}
              >
                {checking ? '请稍候…' : canOpen ? '打开 Pi Desk' : failure ? '重试' : '安装并打开'}
                {!checking && <DesktopIcon name="arrow" />}
              </button>
            )}
          </div>
        </>
      )}
      {!working && !checking && (
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
            {downloadSettings}
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
                        {component.name === 'node' ? '选择已有 Node.js 目录' : '选择已安装的位置'}
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
