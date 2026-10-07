import { Fragment, useId, useRef } from 'react'
import type { BrowserPluginHost, BrowserSettingsPageTarget } from '@jetcrab/pi-desk-sdk/browser'
import {
  PluginActionRow,
  PluginAlert,
  PluginButton,
  PluginCheckbox,
  PluginConfirmDialog,
  PluginInput,
  PluginLoadingState,
  PluginPanelHeader,
  PluginScroll,
  PluginSection,
  PluginSurface,
  PluginTab,
  PluginTabList
} from '@jetcrab/pi-desk-sdk/react/base'
import {
  useContextSettings,
  type ContextSettingsController,
  type ProfileDraft
} from './l2-context-settings-biz.js'

const SETTINGS_STYLES = `
.pi-desk-ctx-settings {
  display: flex;
  width: 100%;
  height: 100%;
  min-height: 0;
  flex-direction: column;
}
.pi-desk-ctx-scroll { min-height: 0; flex: 1; }
.pi-desk-ctx-viewport { padding: 1.5rem; }
.pi-desk-ctx-form { display: grid; max-width: 40rem; gap: 1.5rem; }
.pi-desk-ctx-check { display: flex; min-height: 2rem; align-items: center; gap: .5rem; cursor: pointer; }
.pi-desk-ctx-models { display: grid; gap: .5rem; }
.pi-desk-ctx-model-heading { display: flex; align-items: baseline; justify-content: space-between; gap: .5rem; }
.pi-desk-ctx-model-heading strong { font-weight: 600; }
.pi-desk-ctx-note { color: var(--muted-foreground); font-size: .75rem; }
.pi-desk-ctx-tab-error { color: var(--destructive); }
.pi-desk-ctx-rules { display: grid; gap: .5rem; }
.pi-desk-ctx-rule {
  display: grid;
  min-width: 0;
  grid-template-columns: minmax(0,1fr) auto minmax(0,1fr) auto;
  align-items: start;
  gap: .75rem;
  margin: 0;
  border: 0;
  border-radius: .5rem;
  padding: .75rem;
  background: var(--muted);
}
.pi-desk-ctx-field { display: grid; min-width: 0; align-content: start; gap: .25rem; }
.pi-desk-ctx-label { display: flex; min-height: 2rem; align-items: center; font-weight: 500; }
.pi-desk-ctx-amount { display: grid; min-width: 0; grid-template-columns: 1rem minmax(0,1fr) 1.25rem; align-items: center; gap: .25rem; }
.pi-desk-ctx-operator { text-align: center; }
.pi-desk-ctx-unit { color: var(--muted-foreground); font-size: .75rem; }
.pi-desk-ctx-and { display: grid; height: 2rem; align-items: center; margin-top: 2.25rem; color: var(--muted-foreground); }
.pi-desk-ctx-remove { margin-top: 2.25rem; }
.pi-desk-ctx-or { display: flex; align-items: center; gap: .75rem; color: var(--muted-foreground); font-size: .75rem; }
.pi-desk-ctx-or::before,.pi-desk-ctx-or::after { content: ''; height: 1px; flex: 1; background: var(--border); }
.pi-desk-ctx-error { color: var(--destructive); font-size: .875rem; }
.pi-desk-ctx-rule > .pi-desk-ctx-error { grid-column: 1/-1; }
.pi-desk-ctx-retain { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: .75rem; }
.pi-desk-ctx-empty { color: var(--muted-foreground); padding: .75rem 0; }
.pi-desk-ctx-advanced { border-top: 1px solid var(--border); }
.pi-desk-ctx-advanced > summary { display: flex; min-height: 2rem; align-items: center; gap: .5rem; border-radius: .375rem; padding: .5rem 0; color: var(--muted-foreground); cursor: pointer; list-style: none; }
.pi-desk-ctx-advanced > summary::-webkit-details-marker { display: none; }
.pi-desk-ctx-advanced > summary:hover { color: var(--foreground); }
.pi-desk-ctx-advanced > summary:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }
.pi-desk-ctx-chevron { width: 1rem; height: 1rem; flex: none; transition: transform 150ms ease-out; }
.pi-desk-ctx-advanced[open] .pi-desk-ctx-chevron { transform: rotate(90deg); }
.pi-desk-ctx-advanced-content { display: grid; gap: 1rem; padding-top: .5rem; }
.pi-desk-ctx-checkpoint { display: grid; max-width: 19rem; gap: .25rem; }
.pi-desk-ctx-range { display: flex; align-items: start; gap: .75rem; }
.pi-desk-ctx-range > .pi-desk-ctx-field { flex: 1; max-width: 19rem; }
.pi-desk-ctx-range-delete { margin-top: 2.25rem; }
.pi-desk-ctx-footer { flex: none; border-top: 1px solid var(--border); padding: .75rem 1rem; }
.pi-desk-ctx-footer-end { margin-left: auto; }
.pi-desk-ctx-unsaved { color: var(--muted-foreground); font-size: .75rem; }
.pi-desk-ctx-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
@container (max-width:38rem) {
  .pi-desk-ctx-rule { grid-template-columns: minmax(0,1fr) auto; gap: .25rem .75rem; }
  .pi-desk-ctx-and { grid-column: 1; height: 1.5rem; margin: 0; justify-content: center; }
  .pi-desk-ctx-rule > .pi-desk-ctx-field { grid-column: 1; }
  .pi-desk-ctx-remove { grid-column: 2; grid-row: 1; }
}
@container (max-width:32rem) {
  .pi-desk-ctx-viewport { padding: 1rem; }
  .pi-desk-ctx-retain { grid-template-columns: minmax(0,1fr); }
  .pi-desk-ctx-unsaved { display: none; }
}
@media (prefers-reduced-motion:reduce) { .pi-desk-ctx-chevron { transition: none; } }
`

function rangeLabel(profiles: ProfileDraft[], index: number): string {
  const profile = profiles[index]!
  if (profile.maxContextK === null) return '其他模型'
  if (profile.maxContextK === '') return '新范围'
  const previous = profiles[index - 1]?.maxContextK
  return previous ? `${previous}k–${profile.maxContextK}k` : `≤ ${profile.maxContextK}k`
}

function AmountField({
  label,
  value,
  unit = 'k',
  operator = '≤',
  enabled = true,
  disabled,
  error,
  onChange,
  onBlur,
  toggle
}: {
  label: string
  value: string
  unit?: 'k' | '轮'
  operator?: string
  enabled?: boolean
  disabled: boolean
  error?: string
  onChange(value: string): void
  onBlur?: () => void
  toggle?: (enabled: boolean) => void
}): React.JSX.Element {
  const id = useId()
  return (
    <div className="pi-desk-ctx-field">
      {toggle ? (
        <label className="pi-desk-ctx-check">
          <PluginCheckbox
            checked={enabled}
            disabled={disabled}
            aria-label={`判断${label}`}
            onChange={(event) => toggle(event.target.checked)}
          />
          {label}
        </label>
      ) : (
        <label className="pi-desk-ctx-label" htmlFor={id}>
          {label}
        </label>
      )}
      <div className="pi-desk-ctx-amount">
        <span className="pi-desk-ctx-operator" aria-hidden="true">
          {enabled ? operator : ''}
        </span>
        <PluginInput
          id={id}
          type={enabled ? 'number' : 'text'}
          inputMode={enabled ? (unit === '轮' ? 'numeric' : 'decimal') : undefined}
          step={unit === '轮' ? 1 : 0.001}
          value={enabled ? value : '不限'}
          disabled={disabled || !enabled}
          aria-label={`${label}（${unit}）`}
          aria-invalid={Boolean(error)}
          aria-describedby={error ? `${id}-error` : undefined}
          onChange={(event) => onChange(event.target.value)}
          onBlur={onBlur}
        />
        <span className="pi-desk-ctx-unit" aria-hidden="true">
          {enabled ? unit : ''}
        </span>
      </div>
      {error ? (
        <span className="pi-desk-ctx-error" id={`${id}-error`}>
          {error}
        </span>
      ) : null}
    </div>
  )
}

function ProfileFields({ settings }: { settings: ContextSettingsController }): React.JSX.Element {
  const { profile, saving, issue } = settings
  const fieldError = (field: string): string | undefined =>
    issue?.profileKey === profile.key && issue.field === field ? issue.message : undefined

  return (
    <>
      <PluginSection
        title="何时忽略"
        action={
          <PluginButton
            variant="ghost"
            disabled={saving || profile.rules.length >= 50}
            onClick={settings.addRule}
          >
            + 添加规则
          </PluginButton>
        }
      >
        <div className="pi-desk-ctx-rules">
          {profile.rules.length === 0 ? (
            <div className="pi-desk-ctx-empty">尚未设置自动忽略条件</div>
          ) : (
            profile.rules.map((rule, index) => (
              <Fragment key={index}>
                {index > 0 ? <div className="pi-desk-ctx-or">或</div> : null}
                <fieldset className="pi-desk-ctx-rule">
                  <legend className="pi-desk-ctx-hidden">忽略条件 {index + 1}</legend>
                  <AmountField
                    label="当前用量"
                    operator="≥"
                    value={rule.currentK}
                    enabled={rule.currentEnabled}
                    disabled={saving}
                    error={fieldError(`current-${index}`)}
                    onChange={(currentK) => settings.updateRule(index, { currentK })}
                    toggle={(currentEnabled) => settings.updateRule(index, { currentEnabled })}
                  />
                  <span className="pi-desk-ctx-and">且</span>
                  <AmountField
                    label="忽略后预计"
                    value={rule.projectedK}
                    enabled={rule.projectedEnabled}
                    disabled={saving}
                    error={fieldError(`projected-${index}`)}
                    onChange={(projectedK) => settings.updateRule(index, { projectedK })}
                    toggle={(projectedEnabled) => settings.updateRule(index, { projectedEnabled })}
                  />
                  <PluginButton
                    variant="ghost"
                    className="pi-desk-ctx-remove"
                    aria-label={`移除规则 ${index + 1}`}
                    disabled={saving}
                    onClick={() => settings.removeRule(index)}
                  >
                    移除
                  </PluginButton>
                  {fieldError(`rule-${index}`) ? (
                    <span className="pi-desk-ctx-error" role="alert">
                      {fieldError(`rule-${index}`)}
                    </span>
                  ) : null}
                </fieldset>
              </Fragment>
            ))
          )}
        </div>
      </PluginSection>

      <PluginSection title="保留最近的过程" description="对话与结论始终保留">
        <div className="pi-desk-ctx-retain">
          <AmountField
            label="最近对话轮数"
            unit="轮"
            value={profile.keepRecentUserTurns}
            disabled={saving}
            error={fieldError('keepRecentUserTurns')}
            onChange={(keepRecentUserTurns) => settings.updateProfile({ keepRecentUserTurns })}
          />
          <AmountField
            label="过程用量上限"
            value={profile.processBudgetK}
            disabled={saving}
            error={fieldError('processBudgetK')}
            onChange={(processBudgetK) => settings.updateProfile({ processBudgetK })}
          />
        </div>
      </PluginSection>

      <details
        className="pi-desk-ctx-advanced"
        open={settings.advancedOpen}
        onToggle={(event) => settings.setAdvancedOpen(event.currentTarget.open)}
      >
        <summary>
          <svg className="pi-desk-ctx-chevron" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="m9 6 6 6-6 6" stroke="currentColor" strokeWidth="2" />
          </svg>
          高级设置
        </summary>
        <div className="pi-desk-ctx-advanced-content">
          <div className="pi-desk-ctx-checkpoint">
            <label className="pi-desk-ctx-check">
              <PluginCheckbox
                checked={profile.checkpointEnabled}
                disabled={saving}
                onChange={(event) =>
                  settings.updateProfile({ checkpointEnabled: event.target.checked })
                }
              />
              任务中记录进展
            </label>
            {profile.checkpointEnabled ? (
              <AmountField
                label="达到用量"
                operator="≥"
                value={profile.checkpointK}
                disabled={saving}
                error={fieldError('checkpointK')}
                onChange={(checkpointK) => settings.updateProfile({ checkpointK })}
              />
            ) : null}
          </div>
          {profile.maxContextK !== null ? (
            <div className="pi-desk-ctx-range">
              <AmountField
                label="模型容量上限"
                value={profile.maxContextK}
                disabled={saving}
                error={fieldError('maxContextK')}
                onChange={(maxContextK) => settings.updateProfile({ maxContextK })}
                onBlur={settings.sortProfiles}
              />
              <PluginButton
                variant="ghost"
                className="pi-desk-ctx-range-delete"
                disabled={saving}
                onClick={settings.deleteProfile}
              >
                删除配置
              </PluginButton>
            </div>
          ) : null}
          <PluginActionRow>
            <PluginButton
              variant="ghost"
              disabled={saving || settings.draft.profiles.length >= 20}
              onClick={settings.addProfile}
            >
              + 添加模型范围
            </PluginButton>
          </PluginActionRow>
        </div>
      </details>
    </>
  )
}

export function ContextIgnoreSettingsPage({
  target,
  host,
  signal
}: {
  target: BrowserSettingsPageTarget
  host: BrowserPluginHost
  signal: AbortSignal
}): React.JSX.Element {
  const settings = useContextSettings(target, host, signal)
  const form = useRef<HTMLFormElement>(null)
  const tabId = useId()

  return (
    <PluginSurface className="pi-desk-ctx-settings" data-pi-desk-ctx-settings="">
      <style>{SETTINGS_STYLES}</style>
      <PluginPanelHeader
        title="上下文忽略"
        actions={
          <label className="pi-desk-ctx-check">
            <PluginCheckbox
              checked={settings.draft.enabled}
              disabled={settings.loading || settings.saving}
              onChange={(event) => settings.setEnabled(event.target.checked)}
            />
            自动忽略
          </label>
        }
      />
      <PluginScroll
        className="pi-desk-ctx-scroll"
        viewportClassName="pi-desk-ctx-viewport"
        aria-label="上下文忽略设置"
      >
        <PluginLoadingState
          loading={settings.loading}
          error={!settings.loaded ? settings.error : null}
          onRetry={settings.reload}
        >
          <form
            ref={form}
            className="pi-desk-ctx-form"
            id={`${tabId}-form`}
            noValidate
            onSubmit={(event) => {
              event.preventDefault()
              settings.save()
              if (settings.issue) {
                requestAnimationFrame(() => {
                  form.current?.querySelector<HTMLInputElement>('[aria-invalid="true"]')?.focus()
                })
              }
            }}
          >
            {settings.error ? (
              <PluginAlert tone="error" density="compact">
                {settings.error}
              </PluginAlert>
            ) : null}
            <div className="pi-desk-ctx-models">
              <div className="pi-desk-ctx-model-heading">
                <strong>模型上下文容量</strong>
                <span className="pi-desk-ctx-note">1k = 1,000 tokens</span>
              </div>
              <PluginTabList label="模型上下文容量">
                {settings.draft.profiles.map((profile, index) => (
                  <PluginTab
                    key={profile.key}
                    id={`${tabId}-${profile.key}`}
                    active={settings.profile.key === profile.key}
                    aria-controls={`${tabId}-fields`}
                    disabled={settings.saving}
                    tabIndex={settings.profile.key === profile.key ? 0 : -1}
                    onKeyDown={(event) => {
                      const lastIndex = settings.draft.profiles.length - 1
                      const nextIndex =
                        event.key === 'ArrowRight'
                          ? (index + 1) % (lastIndex + 1)
                          : event.key === 'ArrowLeft'
                            ? (index + lastIndex) % (lastIndex + 1)
                            : event.key === 'Home'
                              ? 0
                              : event.key === 'End'
                                ? lastIndex
                                : null
                      if (nextIndex === null) return
                      event.preventDefault()
                      const nextProfile = settings.draft.profiles[nextIndex]!
                      settings.selectProfile(nextProfile.key)
                      document.getElementById(`${tabId}-${nextProfile.key}`)?.focus()
                    }}
                    onClick={() => settings.selectProfile(profile.key)}
                  >
                    {rangeLabel(settings.draft.profiles, index)}
                    {settings.issue?.profileKey === profile.key ? (
                      <span className="pi-desk-ctx-tab-error" aria-label="配置待完善">
                        {' '}
                        · !
                      </span>
                    ) : null}
                  </PluginTab>
                ))}
              </PluginTabList>
            </div>
            <div
              role="tabpanel"
              id={`${tabId}-fields`}
              aria-labelledby={`${tabId}-${settings.profile.key}`}
              className="pi-desk-ctx-form"
            >
              <ProfileFields settings={settings} />
            </div>
          </form>
        </PluginLoadingState>
      </PluginScroll>
      {!settings.loading && settings.loaded ? (
        <PluginActionRow align="between" className="pi-desk-ctx-footer">
          <PluginButton
            variant="ghost"
            disabled={settings.saving}
            onClick={settings.restoreRecommended}
          >
            恢复推荐
          </PluginButton>
          <PluginActionRow className="pi-desk-ctx-footer-end">
            {settings.dirty ? <span className="pi-desk-ctx-unsaved">未保存</span> : null}
            {settings.dirty ? (
              <PluginButton disabled={settings.saving} onClick={settings.cancel}>
                取消修改
              </PluginButton>
            ) : null}
            <PluginButton
              variant="primary"
              type="submit"
              form={`${tabId}-form`}
              disabled={!settings.dirty || settings.saving}
            >
              {settings.saving ? '保存中…' : '保存'}
            </PluginButton>
          </PluginActionRow>
        </PluginActionRow>
      ) : null}
      <PluginConfirmDialog
        open={settings.leaveOpen}
        title="放弃未保存的更改？"
        confirmLabel="放弃更改"
        tone="danger"
        onConfirm={() => settings.finishLeave(true)}
        onOpenChange={(open) => {
          if (!open) settings.finishLeave(false)
        }}
      />
    </PluginSurface>
  )
}
