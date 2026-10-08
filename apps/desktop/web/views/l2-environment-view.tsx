import type {
  DownloadSource,
  EnvironmentComponent,
  EnvironmentSnapshot,
  TargetSnapshot
} from '../l4-desktop-ipc'
import { DesktopError, DesktopIcon } from '../l4-desktop-ui'

const isMacOS = /Macintosh|Mac OS X/u.test(navigator.userAgent)
const componentLabels = {
  node: 'Node.js',
  pi: 'Pi',
  bash: isMacOS ? 'Git 和 Bash' : 'Git Bash'
} as const
const componentOrder = ['node', 'bash', 'pi'] as const

export type EnvironmentViewAction =
  | { kind: 'prepare' | 'check' | 'cancel' | 'open' | 'settings' | 'copy-error' | 'copy-command' }
  | { kind: 'options'; open: boolean }
  | { kind: 'download-source'; downloadSource: DownloadSource }
  | { kind: 'select'; component: EnvironmentComponent['name']; archive: boolean }
  | { kind: 'help'; component: EnvironmentComponent['name'] }

function bytes(value: number): string {
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`
  return `${(value / 1024 / 1024).toFixed(1)} MB`
}

export type EnvironmentViewProps = {
  environment: EnvironmentSnapshot
  target: TargetSnapshot
  optionsOpen: boolean
  mode: 'prepare' | 'options'
  downloadSource: DownloadSource
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
  downloadSource,
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
  const sourceRequiresLogin = /E401|E403|\b40[13]\b|unauthorized|forbidden/iu.test(failure)
  const canOpen = !target.server?.needsSetup && !checking
  const progress = installing ? environment.download : null
  const percent = progress?.total
    ? Math.min(100, Math.round((progress.received / progress.total) * 100))
    : undefined
  const components = componentOrder.flatMap((name) =>
    environment.components.filter((item) => item.name === name)
  )
  const rows = components.filter((item) => working || item.status !== 'ready' || item.detail)
  const serviceStarting = working && components.every((item) => item.status === 'ready')

  return (
    <section className="environment-panel" aria-label="本机安装" data-options-only={optionsOnly}>
      {working && !optionsOnly && (
        <p className="setup-status" role="status">
          <DesktopIcon name="loader" spinning />
          {installing
            ? progress
              ? '正在下载所需组件…'
              : '正在准备运行组件…'
            : '正在打开 Pi Desk…'}
        </p>
      )}
      {progress && (
        <div className="download-progress" role="status">
          <progress aria-label="下载进度" max={100} value={percent} />
          <p>
            <span>
              {bytes(progress.received)}
              {progress.total ? ` / ${bytes(progress.total)}` : ''}
            </span>
            <span>{percent === undefined ? '' : `${percent}%`}</span>
          </p>
        </div>
      )}
      {failure && (
        <DesktopError
          title={
            sourceRequiresLogin
              ? '下载源需要登录，请更换下载源后重试'
              : '未能完成安装，请重试或查看问题详情'
          }
          detail={failure}
          onCopy={() => onAction({ kind: 'copy-error' })}
          copied={copied === 'error'}
        />
      )}
      {!optionsOnly && (
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
          {sourceRequiresLogin && !working && (
            <button type="button" disabled={locked} onClick={() => onAction({ kind: 'settings' })}>
              修改下载源
            </button>
          )}
        </div>
      )}
      {!optionsOnly && !checking && rows.length > 0 && (
        <details className="disclosure install-detail">
          <summary>
            <DesktopIcon name="chevron" />
            {working ? '安装详情' : '所需组件'}
          </summary>
          {installing && environment.step && <p className="muted">{environment.step}</p>}
          <ol className="setup-steps" aria-label="安装步骤">
            {rows.map((component) => {
              const ready = component.status === 'ready' && !component.detail
              const active = installing && !ready && Boolean(component.detail?.startsWith('正在'))
              return (
                <li key={component.name} className="setup-step">
                  <span className={`component-icon${ready ? ' good' : ''}`}>
                    {ready || active ? (
                      <DesktopIcon name={ready ? 'check' : 'loader'} spinning={active} />
                    ) : (
                      <span className="step-dot" />
                    )}
                  </span>
                  <span className="grow">{componentLabels[component.name]}</span>
                  <span className="step-state">
                    {ready
                      ? '已安装'
                      : active
                        ? component.detail
                        : working
                          ? '等待安装'
                          : component.status === 'ready'
                            ? '需要更新'
                            : '待安装'}
                  </span>
                </li>
              )
            })}
            {working && (
              <li className="setup-step">
                <span className="component-icon">
                  {serviceStarting ? (
                    <DesktopIcon name="loader" spinning />
                  ) : (
                    <span className="step-dot" />
                  )}
                </span>
                <span className="grow">Pi Desk</span>
                <span className="step-state">
                  {serviceStarting ? '正在准备并启动' : '等待启动'}
                </span>
              </li>
            )}
          </ol>
        </details>
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
            <label className="field download-source">
              下载源
              <select
                value={downloadSource}
                disabled={locked}
                onChange={(event) =>
                  onAction({
                    kind: 'download-source',
                    downloadSource: event.target.value as DownloadSource
                  })
                }
              >
                {!isMacOS && <option value="npmmirror">国内镜像</option>}
                <option value="official">官方源</option>
              </select>
            </label>
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
                    {component.name === 'pi' && <p className="code-line">{installCommand}</p>}
                    <div className="actions">
                      {component.name === 'pi' ? (
                        <button
                          type="button"
                          disabled={locked}
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
                      {component.name === 'node' && !isMacOS && (
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
