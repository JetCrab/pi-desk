import { useState, type FormEvent } from 'react'
import { useDesktopSettings } from './hooks/l2-use-desktop-settings'
import { DesktopHeader, DesktopIcon } from './l4-desktop-ui'

type Props = {
  mode: 'target' | 'tunnel'
  originalUrl: string | null
  localTarget: boolean
  initialAdvanced?: boolean
  onDirty: (dirty: boolean) => void
  onSaved: (openUrl?: string) => void
  onBack: () => void
}

export function SettingsPage({
  mode,
  originalUrl,
  localTarget,
  initialAdvanced = false,
  onDirty,
  onSaved,
  onBack
}: Props): React.JSX.Element {
  const { draft, loadError, saveError, saving, patch, reload, save } = useDesktopSettings(
    mode,
    originalUrl,
    onDirty
  )
  const [advanced, setAdvanced] = useState(initialAdvanced)
  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    const result = await save()
    if (result) onSaved(!originalUrl && result.url ? result.url : undefined)
  }
  const disabled = saving || Boolean(loadError)
  return (
    <main className="desktop-settings">
      <DesktopHeader />
      <div className="page-heading">
        <button
          className="icon-button"
          type="button"
          aria-label="返回"
          disabled={saving}
          onClick={onBack}
        >
          <DesktopIcon name="back" />
        </button>
        <h1>
          {mode === 'tunnel' ? '其他设备访问' : originalUrl ? '连接设置' : '连接已有 Pi Desk'}
        </h1>
      </div>
      {loadError && (
        <div className="page-error" role="alert">
          <p>设置读取失败：{loadError}</p>
          <button type="button" onClick={reload}>
            重试
          </button>
        </div>
      )}
      {!draft && !loadError && (
        <p className="loading" role="status">
          <DesktopIcon name="loader" spinning />
          正在读取设置…
        </p>
      )}
      {draft && !loadError && (
        <form onSubmit={(event) => void submit(event)} onInvalid={() => setAdvanced(true)}>
          {mode === 'target' ? (
            <>
              {!originalUrl && <p className="muted">输入电脑或服务器上的地址，即可打开。</p>}
              <label className="field">
                网页地址
                <input
                  required
                  inputMode="url"
                  autoComplete="off"
                  placeholder="例如 http://192.168.1.20:30333"
                  value={draft.url}
                  disabled={disabled}
                  onChange={(event) => patch({ url: event.target.value })}
                />
              </label>
              {draft.serverEnabled && draft.packageEnabled && (
                <section className="settings-section">
                  <h2>启动与更新</h2>
                  <label className="setting-toggle">
                    <span>
                      <span>启动时自动更新</span>
                      <span className="hint">关闭后仍可手动检查更新。</span>
                    </span>
                    <input
                      className="switch"
                      type="checkbox"
                      role="switch"
                      checked={draft.autoUpdateOnStart}
                      disabled={disabled}
                      onChange={(event) => patch({ autoUpdateOnStart: event.target.checked })}
                    />
                  </label>
                  <label className="setting-toggle">
                    <span>
                      <span>运行时自动检查并更新</span>
                      <span className="hint">每分钟检查，安装完成后自动重启服务。</span>
                    </span>
                    <input
                      className="switch"
                      type="checkbox"
                      role="switch"
                      checked={draft.periodicUpdateCheck}
                      disabled={disabled}
                      onChange={(event) => patch({ periodicUpdateCheck: event.target.checked })}
                    />
                  </label>
                </section>
              )}
              {localTarget && (
                <details
                  className="disclosure advanced-settings"
                  open={advanced}
                  onToggle={(event) => setAdvanced(event.currentTarget.open)}
                >
                  <summary>
                    <DesktopIcon name="chevron" />
                    高级设置
                  </summary>
                  <div className="fields">
                    <fieldset>
                      <legend>本机服务</legend>
                      <label className="toggle">
                        <input
                          type="checkbox"
                          checked={draft.serverEnabled}
                          disabled={disabled}
                          onChange={(event) => patch({ serverEnabled: event.target.checked })}
                        />
                        由这台电脑启动服务
                      </label>
                      {draft.serverEnabled && (
                        <div className="fields">
                          <label className="field">
                            启动命令
                            <textarea
                              required
                              autoComplete="off"
                              spellCheck={false}
                              value={draft.startCommand}
                              disabled={disabled}
                              onChange={(event) => patch({ startCommand: event.target.value })}
                            />
                            <span className="hint">
                              {'{port}'} 代表网址端口，{'{package}'} 代表包名和版本。
                            </span>
                          </label>
                          <label className="field">
                            就绪路径
                            <input
                              required
                              autoComplete="off"
                              value={draft.readyPath}
                              disabled={disabled}
                              onChange={(event) => patch({ readyPath: event.target.value })}
                            />
                          </label>
                          <label className="toggle">
                            <input
                              type="checkbox"
                              checked={draft.packageEnabled}
                              disabled={disabled}
                              onChange={(event) => patch({ packageEnabled: event.target.checked })}
                            />
                            管理服务安装包
                          </label>
                          {draft.packageEnabled && (
                            <>
                              <label className="field">
                                包名
                                <input
                                  required
                                  autoComplete="off"
                                  value={draft.packageName}
                                  disabled={disabled}
                                  onChange={(event) => patch({ packageName: event.target.value })}
                                />
                              </label>
                              <label className="field">
                                下载源
                                <input
                                  type="url"
                                  autoComplete="off"
                                  placeholder="使用 npm 默认下载源"
                                  value={draft.packageRegistry}
                                  disabled={disabled}
                                  onChange={(event) =>
                                    patch({ packageRegistry: event.target.value })
                                  }
                                />
                              </label>
                            </>
                          )}
                        </div>
                      )}
                    </fieldset>
                    <fieldset>
                      <legend>其他设备访问</legend>
                      <label className="toggle">
                        <input
                          type="checkbox"
                          checked={draft.tunnelEnabled}
                          disabled={disabled}
                          onChange={(event) => patch({ tunnelEnabled: event.target.checked })}
                        />
                        通过公网端口访问
                      </label>
                      {draft.tunnelEnabled && (
                        <div className="fields">
                          <label className="field">
                            公网端口
                            <input
                              type="number"
                              required
                              min={1}
                              max={65535}
                              step={1}
                              inputMode="numeric"
                              value={draft.publicPort}
                              disabled={disabled}
                              onChange={(event) => patch({ publicPort: event.target.value })}
                            />
                          </label>
                          <label className="toggle">
                            <input
                              type="checkbox"
                              checked={draft.tunnelAutoStart}
                              disabled={disabled}
                              onChange={(event) => patch({ tunnelAutoStart: event.target.checked })}
                            />
                            打开桌面版时自动连接
                          </label>
                        </div>
                      )}
                    </fieldset>
                  </div>
                </details>
              )}
            </>
          ) : (
            <div className="fields">
              <p className="muted">
                填写你的访问服务信息。保存后，在地址的高级设置中配置公网端口。
              </p>
              <label className="field">
                访问服务地址
                <input
                  type="url"
                  autoComplete="off"
                  placeholder="http://tunnel.example.com:7001"
                  value={draft.controlServerUrl}
                  disabled={disabled}
                  onChange={(event) => patch({ controlServerUrl: event.target.value })}
                />
              </label>
              <label className="field">
                连接密钥
                <input
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  value={draft.controlKey}
                  disabled={disabled}
                  onChange={(event) => patch({ controlKey: event.target.value })}
                />
              </label>
            </div>
          )}
          {saveError && (
            <p className="page-error" role="alert">
              {saveError}
            </p>
          )}
          <div className="page-actions">
            <button className="quiet" type="button" disabled={saving} onClick={onBack}>
              取消
            </button>
            <button className="primary" type="submit" disabled={disabled}>
              {saving ? '正在保存…' : mode === 'target' && !originalUrl ? '添加并打开' : '保存设置'}
            </button>
          </div>
        </form>
      )}
    </main>
  )
}
