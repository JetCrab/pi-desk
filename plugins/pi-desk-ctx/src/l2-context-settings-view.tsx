import { useId, useRef, useState } from 'react'
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
  PluginSurface,
  PluginTab,
  PluginTabList
} from '@jetcrab/pi-desk-sdk/react/base'
import {
  useContextSettings,
  type ContextSettingsController,
  type ProfileDraft
} from './l2-context-settings-biz.js'
import { CONTEXT_SETTINGS_STYLES } from './l2-context-settings-styles.js'

const pages = [
  { key: 'process', label: '过程忽略', icon: 'layers' },
  { key: 'images', label: '图片整理', icon: 'image' }
] as const

type SettingsPage = (typeof pages)[number]['key']

function Icon({
  name
}: {
  name: 'layers' | 'image' | 'plus' | 'trash' | 'arrow'
}): React.JSX.Element {
  return (
    <svg
      className="pi-desk-ctx-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {name === 'layers' ? <path d="m12 3 10 5-10 5L2 8Zm-10 9 10 5 10-5M2 16l10 5 10-5" /> : null}
      {name === 'image' ? (
        <>
          <rect x="3" y="3" width="18" height="18" rx="3" />
          <circle cx="8" cy="8" r="1.5" />
          <path d="m21 15-5-5L5 21" />
        </>
      ) : null}
      {name === 'plus' ? <path d="M12 5v14M5 12h14" /> : null}
      {name === 'trash' ? <path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7" /> : null}
      {name === 'arrow' ? <path d="M4 12h16m-6-6 6 6-6 6" /> : null}
    </svg>
  )
}

function rangeLabel(profiles: ProfileDraft[], index: number): string {
  const profile = profiles[index]!
  if (profile.maxContextK === null) return '默认'
  if (profile.maxContextK === '') return '新范围'
  const previous = profiles[index - 1]?.maxContextK
  return previous ? `${previous}k–${profile.maxContextK}k` : `≤ ${profile.maxContextK}k`
}

function nextTabIndex(key: string, index: number, count: number): number | null {
  if (key === 'ArrowRight') return (index + 1) % count
  if (key === 'ArrowLeft') return (index + count - 1) % count
  if (key === 'Home') return 0
  if (key === 'End') return count - 1
  return null
}

function Toggle({
  label,
  checked,
  disabled,
  hideLabel = false,
  onChange
}: {
  label: string
  checked: boolean
  disabled: boolean
  hideLabel?: boolean
  onChange(checked: boolean): void
}): React.JSX.Element {
  return (
    <label className="pi-desk-ctx-toggle">
      <span className={hideLabel ? 'pi-desk-ctx-hidden' : 'pi-desk-ctx-toggle-label'}>{label}</span>
      <PluginCheckbox
        role="switch"
        className="pi-desk-ctx-switch"
        checked={checked}
        disabled={disabled}
        aria-label={label}
        onChange={(event) => onChange(event.target.checked)}
      />
    </label>
  )
}

function AmountField({
  label,
  description,
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
  description?: string
  value: string
  unit?: 'k' | '轮' | 'MiB'
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
      {description ? (
        <span className="pi-desk-ctx-field-description" id={`${id}-description`}>
          {description}
        </span>
      ) : null}
      <div className="pi-desk-ctx-amount">
        {enabled && operator ? (
          <span className="pi-desk-ctx-operator" aria-hidden="true">
            {operator}
          </span>
        ) : null}
        <PluginInput
          id={id}
          className="pi-desk-ctx-input"
          type={enabled ? 'number' : 'text'}
          inputMode={enabled ? (unit === '轮' ? 'numeric' : 'decimal') : undefined}
          step={unit === '轮' ? 1 : 0.001}
          value={enabled ? value : '不限'}
          disabled={disabled || !enabled}
          aria-label={`${label}（${unit}）`}
          aria-invalid={Boolean(error)}
          aria-describedby={error ? `${id}-error` : description ? `${id}-description` : undefined}
          onChange={(event) => onChange(event.target.value)}
          onBlur={onBlur}
        />
        {enabled ? (
          <span className="pi-desk-ctx-unit" aria-hidden="true">
            {unit}
          </span>
        ) : null}
      </div>
      {error ? (
        <span className="pi-desk-ctx-error" id={`${id}-error`}>
          {error}
        </span>
      ) : null}
    </div>
  )
}

function ImageBudgetFields({
  settings
}: {
  settings: ContextSettingsController
}): React.JSX.Element {
  const { imageBudget } = settings.draft
  const disabled = settings.saving || !imageBudget.enabled
  const fieldError = (field: string): string | undefined =>
    settings.issue?.profileKey === null && settings.issue.field === field
      ? settings.issue.message
      : undefined

  return (
    <>
      <div className="pi-desk-ctx-activation">
        <div>
          <h3>自动整理图片</h3>
          <p className="pi-desk-ctx-note">限制发送给模型的图片总量，原图与聊天历史不变。</p>
        </div>
        <Toggle
          label="自动整理图片"
          hideLabel
          checked={imageBudget.enabled}
          disabled={settings.saving}
          onChange={(enabled) => settings.updateImageBudget({ enabled })}
        />
      </div>
      <div className="pi-desk-ctx-image-budget">
        <AmountField
          label="图片总量超过"
          unit="MiB"
          operator=">"
          value={imageBudget.triggerMiB}
          disabled={disabled}
          error={fieldError('triggerMiB')}
          onChange={(triggerMiB) => settings.updateImageBudget({ triggerMiB })}
        />
        <span className="pi-desk-ctx-image-arrow">
          <Icon name="arrow" />
        </span>
        <AmountField
          label="收紧至不超过"
          unit="MiB"
          value={imageBudget.targetMiB}
          disabled={disabled}
          error={fieldError('targetMiB')}
          onChange={(targetMiB) => settings.updateImageBudget({ targetMiB })}
        />
      </div>
      <section className="pi-desk-ctx-section" aria-label="历史图片保留范围">
        <h3>历史图片保留范围</h3>
        <p className="pi-desk-ctx-note">先保留同时位于以下两个窗口内的图片，再按目标大小收紧。</p>
        <div className="pi-desk-ctx-image-retain">
          <AmountField
            label="最近有效助手轮数"
            description="包含正文或工具调用的助手回应"
            unit="轮"
            operator=""
            value={imageBudget.keepAssistantTurns}
            disabled={disabled}
            error={fieldError('keepAssistantTurns')}
            onChange={(keepAssistantTurns) => settings.updateImageBudget({ keepAssistantTurns })}
          />
          <AmountField
            label="最近带正文的助手轮数"
            description="仅计算有正文的回应，不含内部思考"
            unit="轮"
            operator=""
            value={imageBudget.keepTextTurns}
            disabled={disabled}
            error={fieldError('keepTextTurns')}
            onChange={(keepTextTurns) => settings.updateImageBudget({ keepTextTurns })}
          />
        </div>
        <p className="pi-desk-ctx-note">错误、取消和空回应不计入轮数。</p>
      </section>
      <div className="pi-desk-ctx-image-notice">
        <h3>新图片自身超限时，不会直接丢弃</h3>
        <p className="pi-desk-ctx-note">
          系统将停止本次发送，并提示分批提交。图片整理只影响发送给模型的内容，不修改原图或聊天历史。
        </p>
      </div>
    </>
  )
}

function ProfileFields({
  settings,
  onDelete
}: {
  settings: ContextSettingsController
  onDelete(): void
}): React.JSX.Element {
  const { profile, saving, issue } = settings
  const profileIndex = settings.draft.profiles.findIndex(
    (candidate) => candidate.key === profile.key
  )
  const previous = settings.draft.profiles[profileIndex - 1]?.maxContextK
  const fieldError = (field: string): string | undefined =>
    issue?.profileKey === profile.key && issue.field === field ? issue.message : undefined

  return (
    <>
      <div className="pi-desk-ctx-range">
        {profile.maxContextK === null ? (
          <p className="pi-desk-ctx-note">未匹配到以上范围的模型使用此配置。</p>
        ) : (
          <>
            <div className="pi-desk-ctx-range-expression">
              <span>{previous ? `${previous}k < 模型容量` : '模型容量'}</span>
              <div className="pi-desk-ctx-range-field" data-range-input="">
                <AmountField
                  label="模型容量上限"
                  value={profile.maxContextK}
                  disabled={saving}
                  error={fieldError('maxContextK')}
                  onChange={(maxContextK) => settings.updateProfile({ maxContextK })}
                  onBlur={settings.sortProfiles}
                />
              </div>
            </div>
            <PluginButton
              variant="ghost"
              className="pi-desk-ctx-delete"
              disabled={saving}
              onClick={onDelete}
            >
              删除范围
            </PluginButton>
          </>
        )}
      </div>
      <section className="pi-desk-ctx-section" aria-label="触发条件">
        <div className="pi-desk-ctx-heading">
          <div className="pi-desk-ctx-heading-copy">
            <h3>触发条件</h3>
            <span className="pi-desk-ctx-note">满足任一规则即可触发</span>
          </div>
          <PluginButton
            variant="ghost"
            disabled={saving || profile.rules.length >= 50}
            onClick={settings.addRule}
          >
            <Icon name="plus" />
            添加规则
          </PluginButton>
        </div>
        <div className="pi-desk-ctx-rules">
          {profile.rules.length === 0 ? (
            <div className="pi-desk-ctx-empty">暂无触发规则。添加规则后才会自动忽略过程。</div>
          ) : (
            profile.rules.map((rule, index) => (
              <div className="pi-desk-ctx-rule-wrap" key={index}>
                {index > 0 ? <span className="pi-desk-ctx-or">或</span> : null}
                <fieldset
                  className="pi-desk-ctx-rule"
                  tabIndex={-1}
                  aria-invalid={Boolean(fieldError(`rule-${index}`))}
                >
                  <legend className="pi-desk-ctx-hidden">忽略条件 {index + 1}</legend>
                  <span className="pi-desk-ctx-rule-number" aria-hidden="true">
                    {String(index + 1).padStart(2, '0')}
                  </span>
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
                  <span className="pi-desk-ctx-and">
                    {rule.currentEnabled && rule.projectedEnabled ? '且' : '—'}
                  </span>
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
                    className="pi-desk-ctx-icon-button pi-desk-ctx-delete"
                    aria-label={`移除规则 ${index + 1}`}
                    title={`移除规则 ${index + 1}`}
                    disabled={saving}
                    onClick={() => settings.removeRule(index)}
                  >
                    <Icon name="trash" />
                  </PluginButton>
                  {fieldError(`rule-${index}`) ? (
                    <span className="pi-desk-ctx-error" role="alert">
                      {fieldError(`rule-${index}`)}
                    </span>
                  ) : null}
                </fieldset>
              </div>
            ))
          )}
        </div>
      </section>
      <section className="pi-desk-ctx-section" aria-label="保留最近的过程">
        <div className="pi-desk-ctx-heading pi-desk-ctx-retain-heading">
          <h3>保留最近的过程</h3>
          <span className="pi-desk-ctx-note">对话与结论始终保留</span>
        </div>
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
      </section>
      <section className="pi-desk-ctx-checkpoint" aria-label="任务中记录进展">
        <div>
          <h3>任务中记录进展</h3>
          <p className="pi-desk-ctx-note">达到指定用量时，先记录当前任务进展。</p>
        </div>
        <div className="pi-desk-ctx-checkpoint-controls">
          <div className="pi-desk-ctx-checkpoint-amount">
            <AmountField
              label="记录进展触发用量"
              operator="≥"
              value={profile.checkpointK}
              disabled={saving || !profile.checkpointEnabled}
              error={fieldError('checkpointK')}
              onChange={(checkpointK) => settings.updateProfile({ checkpointK })}
            />
          </div>
          <Toggle
            label="任务中记录进展"
            hideLabel
            checked={profile.checkpointEnabled}
            disabled={saving}
            onChange={(checkpointEnabled) => settings.updateProfile({ checkpointEnabled })}
          />
        </div>
      </section>
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
  const viewport = useRef<HTMLDivElement>(null)
  const scrollPositions = useRef({ process: 0, images: 0 })
  const [page, setPage] = useState<SettingsPage>('process')
  const [confirmation, setConfirmation] = useState<'delete' | 'restore' | null>(null)
  const tabId = useId()

  const selectPage = (next: SettingsPage): void => {
    if (next === page) return
    scrollPositions.current[page] = viewport.current?.scrollTop ?? 0
    setPage(next)
    requestAnimationFrame(() => {
      viewport.current?.scrollTo({ top: scrollPositions.current[next] })
    })
  }
  const focusInvalid = (): void => {
    requestAnimationFrame(() => {
      form.current
        ?.querySelector<HTMLElement>('[role="tabpanel"]:not([hidden]) [aria-invalid="true"]')
        ?.focus()
    })
  }

  return (
    <PluginSurface className="pi-desk-ctx-settings" data-pi-desk-ctx-settings="">
      <style>{CONTEXT_SETTINGS_STYLES}</style>
      <PluginPanelHeader
        className="pi-desk-ctx-header"
        title="上下文忽略"
        description="减少历史过程占用，为当前任务留出空间。"
        actions={
          <a
            href="https://pidesk.dev/docs/context/"
            target="_blank"
            rel="noopener noreferrer"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              minHeight: '2rem',
              color: 'var(--muted-foreground)',
              fontSize: '.875rem',
              whiteSpace: 'nowrap',
              textDecoration: 'underline',
              textUnderlineOffset: '.2em'
            }}
          >
            使用说明 ↗
          </a>
        }
      />
      <PluginTabList className="pi-desk-ctx-pages" label="上下文忽略设置类别">
        {pages.map((item, index) => (
          <PluginTab
            key={item.key}
            id={`${tabId}-${item.key}`}
            active={page === item.key}
            aria-controls={`${tabId}-${item.key}-panel`}
            disabled={settings.saving}
            tabIndex={page === item.key ? 0 : -1}
            onClick={() => selectPage(item.key)}
            onKeyDown={(event) => {
              const next = nextTabIndex(event.key, index, pages.length)
              if (next === null) return
              event.preventDefault()
              selectPage(pages[next]!.key)
              document.getElementById(`${tabId}-${pages[next]!.key}`)?.focus()
            }}
          >
            <Icon name={item.icon} />
            {item.label}
          </PluginTab>
        ))}
      </PluginTabList>
      <PluginScroll
        className="pi-desk-ctx-scroll"
        viewportClassName="pi-desk-ctx-viewport"
        viewportRef={viewport}
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
              if (settings.issue)
                selectPage(settings.issue.profileKey === null ? 'images' : 'process')
              settings.save()
              if (settings.issue) focusInvalid()
            }}
          >
            {settings.error ? <PluginAlert tone="error">{settings.error}</PluginAlert> : null}
            <div
              className="pi-desk-ctx-panel"
              role="tabpanel"
              id={`${tabId}-process-panel`}
              aria-labelledby={`${tabId}-process`}
              hidden={page !== 'process'}
            >
              <div className="pi-desk-ctx-heading">
                <div className="pi-desk-ctx-heading-copy">
                  <h3>模型上下文容量</h3>
                  <span className="pi-desk-ctx-note">1k = 1,000 tokens</span>
                </div>
                <Toggle
                  label="自动忽略过程"
                  checked={settings.draft.enabled}
                  disabled={settings.saving}
                  onChange={settings.setEnabled}
                />
              </div>
              {!settings.draft.enabled ? (
                <p className="pi-desk-ctx-paused">自动忽略已暂停。以下配置会保留，仍可继续编辑。</p>
              ) : null}
              <div className="pi-desk-ctx-model-scroll">
                <div className="pi-desk-ctx-model-row">
                  <PluginTabList className="pi-desk-ctx-model-tabs" label="模型上下文容量">
                    {settings.draft.profiles.map((profile, index) => (
                      <PluginTab
                        key={profile.key}
                        className="pi-desk-ctx-model-tab"
                        id={`${tabId}-range-${profile.key}`}
                        active={settings.profile.key === profile.key}
                        aria-controls={`${tabId}-fields`}
                        disabled={settings.saving}
                        tabIndex={settings.profile.key === profile.key ? 0 : -1}
                        onKeyDown={(event) => {
                          const nextIndex = nextTabIndex(
                            event.key,
                            index,
                            settings.draft.profiles.length
                          )
                          if (nextIndex === null) return
                          event.preventDefault()
                          const next = settings.draft.profiles[nextIndex]!
                          settings.selectProfile(next.key)
                          document.getElementById(`${tabId}-range-${next.key}`)?.focus()
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
                  <PluginButton
                    variant="ghost"
                    className="pi-desk-ctx-icon-button"
                    aria-label="添加模型范围"
                    title="添加模型范围"
                    disabled={settings.saving || settings.draft.profiles.length >= 20}
                    onClick={() => {
                      settings.addProfile()
                      requestAnimationFrame(() =>
                        form.current
                          ?.querySelector<HTMLInputElement>('[data-range-input] input')
                          ?.focus()
                      )
                    }}
                  >
                    <Icon name="plus" />
                  </PluginButton>
                </div>
              </div>
              <div
                role="tabpanel"
                id={`${tabId}-fields`}
                aria-labelledby={`${tabId}-range-${settings.profile.key}`}
              >
                <ProfileFields settings={settings} onDelete={() => setConfirmation('delete')} />
              </div>
            </div>
            <div
              className="pi-desk-ctx-panel"
              role="tabpanel"
              id={`${tabId}-images-panel`}
              aria-labelledby={`${tabId}-images`}
              hidden={page !== 'images'}
            >
              <ImageBudgetFields settings={settings} />
            </div>
          </form>
        </PluginLoadingState>
      </PluginScroll>
      {!settings.loading && settings.loaded ? (
        <PluginActionRow align="between" className="pi-desk-ctx-footer">
          <PluginButton
            variant="ghost"
            disabled={settings.saving}
            onClick={() => setConfirmation('restore')}
          >
            恢复推荐
          </PluginButton>
          <PluginActionRow className="pi-desk-ctx-footer-end">
            {settings.dirty ? (
              <>
                <span className="pi-desk-ctx-unsaved">未保存</span>
                <PluginButton disabled={settings.saving} onClick={settings.cancel}>
                  撤销修改
                </PluginButton>
              </>
            ) : null}
            <PluginButton
              variant="primary"
              type="submit"
              form={`${tabId}-form`}
              disabled={!settings.dirty || settings.saving}
            >
              {settings.saving ? '保存中…' : '保存设置'}
            </PluginButton>
          </PluginActionRow>
        </PluginActionRow>
      ) : null}
      <PluginConfirmDialog
        open={confirmation !== null}
        title={confirmation === 'delete' ? '删除当前模型范围？' : '恢复全部推荐设置？'}
        description={
          confirmation === 'delete'
            ? '仅移除这个范围的配置。对应模型将使用下一个适用范围；保存后生效。'
            : '过程忽略和图片整理都将恢复推荐值，当前修改会被替换。点击保存后才会生效。'
        }
        confirmLabel={confirmation === 'delete' ? '删除范围' : '恢复推荐'}
        tone={confirmation === 'delete' ? 'danger' : undefined}
        onConfirm={() => {
          if (confirmation === 'delete') settings.deleteProfile()
          else settings.restoreRecommended()
          setConfirmation(null)
          requestAnimationFrame(() =>
            form.current
              ?.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')
              ?.focus()
          )
        }}
        onOpenChange={(open) => {
          if (!open) setConfirmation(null)
        }}
      />
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
