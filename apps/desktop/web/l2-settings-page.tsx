import { useEffect, useState, type CSSProperties, type FormEvent } from 'react'
import { useDesktopSettings } from './hooks/l2-use-desktop-settings'
import { type ControlState, type ReleaseChannel, type UpdatePolicy } from './l4-desktop-ipc'
import { DesktopHeader, DesktopIcon } from './l4-desktop-ui'
import { ConfigurationPreferences } from './views/l2-startup-preference'
import { DownloadSourceSettings } from './views/l2-download-source-settings'

const updatePolicies = [
  { value: 'none', label: '无' },
  { value: 'update', label: '自动更新' },
  { value: 'check', label: '检查更新' }
] as const

const updateGroups = [
  { field: 'startupUpdate', label: '启动时', prefix: '启动' },
  { field: 'periodicUpdate', label: '定时', prefix: '定时' }
] as const

const releaseChannels = [
  { value: 'stable', label: '稳定版' },
  { value: 'dev', label: '开发版' }
] as const

// 共享样式将非 checkbox 输入视作文本框，单选保留原生外观与紧凑尺寸。
const radioStyle: CSSProperties = {
  accentColor: 'var(--primary)',
  width: 16,
  height: 16,
  minHeight: 16,
  margin: 0,
  padding: 0,
  border: 0,
  borderRadius: '50%',
  flex: 'none',
  cursor: 'pointer',
  outlineOffset: 2
}

const optionsStyle: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: '4px 16px'
}

type Props = {
  originalUrl: string | null
  localTarget: boolean
  initialAdvanced?: boolean
  onDirty: (dirty: boolean) => void
  onSaved: (openUrl?: string) => void
  onBack: () => void
}

export function SettingsPage({
  state,
  readError,
  refresh,
  global = false,
  onSelectTarget,
  ...props
}: Props & {
  state: ControlState | null
  readError: string
  refresh: () => void
  global?: boolean
  onSelectTarget: (url: string) => void
}): React.JSX.Element {
  const [targetSaving, setTargetSaving] = useState(false)
  const local = state?.targets.filter((target) => target.server) ?? []
  const selected = props.originalUrl
    ? local.find((target) => target.url === props.originalUrl)
    : local[0]
  const targetUrl = global ? (selected?.url ?? null) : props.originalUrl
  const showTarget = !global || Boolean(selected)

  return (
    <main className="desktop-settings">
      <DesktopHeader />
      <div className="page-heading">
        <button
          className="icon-button"
          type="button"
          aria-label="返回"
          disabled={targetSaving}
          onClick={props.onBack}
        >
          <DesktopIcon name="back" />
        </button>
        <h1>{global ? '设置' : props.localTarget ? '本机设置' : '连接已有 Pi Desk'}</h1>
      </div>
      {readError && (
        <div className="page-error" role="alert">
          <p>暂时无法读取状态：{readError}</p>
          <button type="button" onClick={refresh}>
            重新读取
          </button>
        </div>
      )}
      {(global || props.localTarget) && (
        <>
          <ConfigurationPreferences state={state} refresh={refresh} />
          <DownloadSourceSettings />
        </>
      )}
      {global && selected && (
        <div className="settings-target-heading">
          <h2>本机设置</h2>
          {local.length > 1 ? (
            <label className="field">
              本机地址
              <select
                value={selected.url}
                disabled={targetSaving}
                onChange={(event) => onSelectTarget(event.target.value)}
              >
                {local.map((target) => (
                  <option key={target.url} value={target.url}>
                    {target.url}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <p className="muted path-text">{selected.url}</p>
          )}
        </div>
      )}
      {global && !state && !readError && (
        <p className="loading" role="status">
          正在读取设置…
        </p>
      )}
      {global && state && props.originalUrl && !selected && (
        <p className="page-error" role="alert">
          这个本机地址已被移除，请返回后重新选择。
        </p>
      )}
      {showTarget && (
        <TargetSettingsForm
          key={targetUrl ?? 'new'}
          {...props}
          originalUrl={targetUrl}
          localTarget={global || props.localTarget}
          onSavingChange={setTargetSaving}
        />
      )}
    </main>
  )
}

function TargetSettingsForm({
  originalUrl,
  localTarget,
  initialAdvanced = false,
  onDirty,
  onSaved,
  onBack,
  onSavingChange
}: Props & { onSavingChange: (saving: boolean) => void }): React.JSX.Element {
  const { draft, loadError, saveError, saving, patch, reload, save } = useDesktopSettings(
    originalUrl,
    onDirty
  )
  useEffect(() => {
    onSavingChange(saving)
  }, [saving, onSavingChange])
  const [advanced, setAdvanced] = useState(initialAdvanced)
  const selectUpdatePolicy = (
    field: 'startupUpdate' | 'periodicUpdate',
    value: UpdatePolicy
  ): void => {
    if (!draft || draft[field] === value) return
    if (
      field === 'periodicUpdate' &&
      value === 'update' &&
      !window.confirm('定时自动更新会重启服务，导致运行中的任务被打断。请谨慎开启。确定继续吗？')
    )
      return
    patch({ [field]: value })
  }
  const selectChannel = (value: ReleaseChannel): void => {
    if (!draft || draft.channel === value) return
    if (value === 'dev' && !window.confirm('开发版可能不稳定，不建议日常使用。确定选择开发版吗？'))
      return
    patch({ channel: value })
  }
  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    const result = await save()
    if (result) onSaved(!originalUrl && result.url ? result.url : undefined)
  }
  const disabled = saving || Boolean(loadError)
  return (
    <>
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
                <h2>服务更新</h2>
                {updateGroups.map((group) => (
                  <fieldset key={group.field}>
                    <legend>{group.label}</legend>
                    <div className="field" style={optionsStyle}>
                      {updatePolicies.map((option) => (
                        <label className="toggle" key={option.value}>
                          <input
                            type="radio"
                            name={group.field}
                            value={option.value}
                            style={radioStyle}
                            checked={draft[group.field] === option.value}
                            disabled={disabled}
                            onChange={() => selectUpdatePolicy(group.field, option.value)}
                          />
                          {option.value === 'none'
                            ? option.label
                            : `${group.prefix}${option.label}`}
                        </label>
                      ))}
                    </div>
                  </fieldset>
                ))}
                <fieldset>
                  <legend>版本</legend>
                  <div className="field" style={optionsStyle}>
                    {releaseChannels.map((option) => (
                      <label className="toggle" key={option.value}>
                        <input
                          type="radio"
                          name="channel"
                          value={option.value}
                          style={radioStyle}
                          checked={draft.channel === option.value}
                          disabled={disabled}
                          onChange={() => selectChannel(option.value)}
                        />
                        {option.label}
                      </label>
                    ))}
                  </div>
                </fieldset>
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
                        )}
                      </div>
                    )}
                  </fieldset>
                </div>
              </details>
            )}
          </>
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
              {saving ? '正在保存…' : !originalUrl ? '添加并打开' : '保存设置'}
            </button>
          </div>
        </form>
      )}
    </>
  )
}
