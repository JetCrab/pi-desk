import { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type {
  BrowserPluginHost,
  BrowserSettingsPageImplementation,
  BrowserSettingsPageTarget
} from '@jetcrab/pi-desk-sdk/browser'
import {
  PluginAlert,
  PluginButton,
  PluginCheckbox,
  PluginConfirmDialog,
  PluginErrorBoundary,
  PluginLoadingState,
  PluginPanelHeader,
  PluginSelectField,
  PluginSurface
} from '@jetcrab/pi-desk-sdk/react/base'

type AgentSetting = { name: string; model: string; thinking: string | null; disabled: boolean }
type ModelOption = { provider: string; modelId: string; name: string }
type SettingsData = { agents: AgentSetting[]; models: ModelOption[] }

const thinkingOptions = [
  { value: '', label: '角色默认' },
  { value: 'off', label: '关闭' },
  { value: 'minimal', label: '极低' },
  { value: 'low', label: '低' },
  { value: 'medium', label: '中' },
  { value: 'high', label: '高' },
  { value: 'xhigh', label: '极高' },
  { value: 'max', label: '最大' }
]

const styles = `
.subagent-settings {
  min-height: 100%;
  container-name: subagent-settings;
  background: var(--pi-desk-plugin-background, var(--background));
}
.subagent-settings .subagent-settings-header {
  position: sticky;
  top: 0;
  z-index: 1;
  padding: 1rem;
  background: var(--pi-desk-plugin-background, var(--background));
}
.subagent-settings-content {
  display: grid;
  gap: 1rem;
  min-width: 0;
  padding: 1rem;
}
.subagent-settings-columns { display: none; }
.subagent-settings-agent {
  display: grid;
  gap: .75rem;
  min-width: 0;
  padding: .75rem 0;
  border-bottom: 1px solid var(--pi-desk-plugin-border, var(--border));
}
.subagent-settings-agent:last-child { border-bottom: 0; }
.subagent-settings-toggle {
  display: flex;
  align-items: center;
  gap: .5rem;
  min-width: 0;
  min-height: 2rem;
  font-weight: 500;
  cursor: pointer;
}
.subagent-settings-toggle span { overflow-wrap: anywhere; }
.subagent-settings-fields { display: grid; min-width: 0; gap: .75rem; }
.subagent-settings-note {
  margin: 0;
  color: var(--pi-desk-plugin-muted-foreground, var(--muted-foreground));
}
@container subagent-settings (min-width: 34rem) {
  .subagent-settings-fields { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@container subagent-settings (min-width: 40rem) {
  .subagent-settings .subagent-settings-header { padding: 1.5rem; }
  .subagent-settings-content { padding: 1rem 1.5rem 1.5rem; }
  .subagent-settings-columns, .subagent-settings-agent {
    display: grid;
    grid-template-columns: 8rem minmax(0, 1fr) 9rem;
    align-items: center;
    gap: .75rem;
  }
  .subagent-settings-columns {
    min-height: 2rem;
    border-bottom: 1px solid var(--pi-desk-plugin-border, var(--border));
    color: var(--pi-desk-plugin-muted-foreground, var(--muted-foreground));
    font-size: .75rem;
    font-weight: 500;
  }
  .subagent-settings-fields { display: contents; }
  .subagent-settings-field > label {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
    border: 0;
  }
}
`

function Settings({
  host,
  target,
  signal
}: {
  host: BrowserPluginHost
  target: BrowserSettingsPageTarget
  signal: AbortSignal
}): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<SettingsData | null>(null)
  const [draft, setDraft] = useState<AgentSetting[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmLeave, setConfirmLeave] = useState(false)
  const leaveResolver = useRef<((allowed: boolean) => void) | null>(null)
  const dirty = snapshot !== null && JSON.stringify(draft) !== JSON.stringify(snapshot.agents)

  useEffect(() => {
    target.setBeforeLeave(() => {
      if (saving) return false
      if (!dirty) return true
      return new Promise<boolean>((resolve) => {
        leaveResolver.current?.(false)
        leaveResolver.current = resolve
        setConfirmLeave(true)
      })
    })
    return () => {
      target.setBeforeLeave(null)
      leaveResolver.current?.(false)
      leaveResolver.current = null
    }
  }, [target, dirty, saving])

  async function requestSettings(): Promise<SettingsData> {
    return (await host.piDesk.invokeGlobal('settings-get', {})) as SettingsData
  }

  function applySettings(data: SettingsData): void {
    if (signal.aborted) return
    setSnapshot(data)
    setDraft(data.agents)
  }

  function showLoadError(cause: unknown): void {
    if (!signal.aborted) setError(cause instanceof Error ? cause.message : String(cause))
  }

  function finishLoad(): void {
    if (!signal.aborted) setLoading(false)
  }

  async function load(): Promise<void> {
    await requestSettings().then(applySettings).catch(showLoadError).finally(finishLoad)
  }

  async function retry(): Promise<void> {
    setLoading(true)
    setError(null)
    await load()
  }

  useEffect(() => {
    void requestSettings().then(applySettings).catch(showLoadError).finally(finishLoad)
    // 此页只在 mount 时读取；后续刷新由用户操作触发。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function update(name: string, change: Partial<AgentSetting>): void {
    setDraft((current) =>
      current.map((agent) => (agent.name === name ? { ...agent, ...change } : agent))
    )
  }

  async function save(): Promise<void> {
    if (!snapshot || !dirty || saving) return
    setSaving(true)
    setError(null)
    try {
      const changes = draft.filter(
        (agent, index) => JSON.stringify(agent) !== JSON.stringify(snapshot.agents[index])
      )
      const data = (await host.piDesk.invokeGlobal('settings-save', { agents: changes })) as {
        agents: AgentSetting[]
      }
      if (signal.aborted) return
      setSnapshot({ ...snapshot, agents: data.agents })
      setDraft(data.agents)
      host.notify({ level: 'success', title: '子代理设置已保存' })
    } catch (cause) {
      if (!signal.aborted) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (!signal.aborted) setSaving(false)
    }
  }

  const modelOptions = [
    { value: '', label: '角色默认模型' },
    ...(snapshot?.models ?? []).map((model) => ({
      value: `${model.provider}/${model.modelId}`,
      label: `${model.provider} / ${model.name || model.modelId}`,
      textValue: `${model.provider} ${model.modelId}`
    }))
  ]
  return (
    <PluginSurface className="subagent-settings">
      <style>{styles}</style>
      <PluginPanelHeader
        className="subagent-settings-header"
        title="子代理"
        description="全局默认配置，项目设置优先。"
        actions={
          <PluginButton disabled={!dirty || saving} onClick={() => void save()}>
            {saving ? '保存中…' : '保存设置'}
          </PluginButton>
        }
      />
      <div className="subagent-settings-content">
        <PluginLoadingState
          loading={loading && !snapshot}
          error={!snapshot ? error : null}
          onRetry={() => void retry()}
        >
          {snapshot ? (
            <>
              <div className="subagent-settings-list">
                <div className="subagent-settings-columns" aria-hidden="true">
                  <span>子代理</span>
                  <span>模型</span>
                  <span>思考等级</span>
                </div>
                {draft.map((agent) => {
                  const options = [...modelOptions]
                  if (agent.model && !options.some((option) => option.value === agent.model)) {
                    options.push({ value: agent.model, label: `${agent.model}（当前不可用）` })
                  }
                  return (
                    <div
                      className="subagent-settings-agent"
                      key={agent.name}
                      role="group"
                      aria-label={agent.name}
                    >
                      <label className="subagent-settings-toggle">
                        <PluginCheckbox
                          aria-label={`启用 ${agent.name}`}
                          checked={!agent.disabled}
                          disabled={saving}
                          onChange={(event) =>
                            update(agent.name, { disabled: !event.target.checked })
                          }
                        />
                        <span>{agent.name}</span>
                      </label>
                      <div className="subagent-settings-fields">
                        <PluginSelectField
                          className="subagent-settings-field"
                          label="模型"
                          value={agent.model}
                          options={options}
                          disabled={saving || agent.disabled}
                          onValueChange={(value) =>
                            update(agent.name, {
                              model: value ?? '',
                              thinking: value ? agent.thinking : null
                            })
                          }
                        />
                        <PluginSelectField
                          className="subagent-settings-field"
                          label="思考等级"
                          value={agent.thinking ?? ''}
                          options={thinkingOptions}
                          disabled={saving || agent.disabled || !agent.model}
                          onValueChange={(value) => update(agent.name, { thinking: value || null })}
                        />
                      </div>
                    </div>
                  )
                })}
              </div>
              {error ? (
                <PluginAlert tone="error" density="compact">
                  {error}
                </PluginAlert>
              ) : null}
              <p className="subagent-settings-note">
                保存后下次启动或恢复子代理时生效，运行中的任务不受影响。
              </p>
            </>
          ) : null}
        </PluginLoadingState>
      </div>
      <PluginConfirmDialog
        open={confirmLeave}
        title="放弃未保存的设置？"
        confirmLabel="放弃修改"
        onConfirm={() => {
          leaveResolver.current?.(true)
          leaveResolver.current = null
          setConfirmLeave(false)
        }}
        onOpenChange={(open) => {
          if (!open) {
            leaveResolver.current?.(false)
            leaveResolver.current = null
            setConfirmLeave(false)
          }
        }}
      />
    </PluginSurface>
  )
}

let mountId = 0
const implementation: BrowserSettingsPageImplementation = {
  mount({ container, host, target, signal }) {
    const root = createRoot(container, { identifierPrefix: `subagent-settings-${++mountId}-` })
    root.render(
      <PluginErrorBoundary
        onError={(error) =>
          host.notify({ level: 'error', title: '子代理设置显示失败', description: error.message })
        }
      >
        <Settings host={host} target={target} signal={signal} />
      </PluginErrorBoundary>
    )
    return () => root.unmount()
  }
}
export default implementation
