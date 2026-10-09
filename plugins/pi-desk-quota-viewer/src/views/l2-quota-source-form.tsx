import {
  PluginAlert,
  PluginCheckbox,
  PluginField,
  PluginInput,
  PluginSecretInput,
  PluginSelect,
  PluginTextarea
} from '@jetcrab/pi-desk-sdk/react/base'
import { fieldId, type DraftSource } from '../hooks/l2-quota-settings.js'
import type { QuotaAdapterDescriptor } from '../protocol.js'
import { quotaText, type QuotaLocale } from '../l2-quota-locale.js'

export function QuotaSourceForm({
  source,
  locale,
  descriptor,
  errors,
  disabled,
  onChange
}: {
  source: DraftSource
  locale: QuotaLocale
  descriptor: QuotaAdapterDescriptor | undefined
  errors: ReadonlyMap<string, string>
  disabled: boolean
  onChange(source: DraftSource): void
}): React.JSX.Element {
  const t = (text: string): string => quotaText(locale, text)
  const updateValue = (key: string, value: string): void => {
    onChange({ ...source, values: { ...source.values, [key]: value } })
  }
  return (
    <div className="quota-source-form" data-quota-settings-source={source.draftKey}>
      {!descriptor ? (
        <PluginAlert tone="error" density="compact">
          {t('当前渠道不可用，可删除此来源。')}
        </PluginAlert>
      ) : null}
      <PluginField
        label={t('显示名称')}
        htmlFor={fieldId(source, 'name')}
        error={errors.get(`${source.draftKey}:name`)}
      >
        <PluginInput
          id={fieldId(source, 'name')}
          value={source.name}
          maxLength={100}
          disabled={disabled}
          onChange={(event) => onChange({ ...source, name: event.target.value })}
        />
      </PluginField>
      <label className="quota-source-enabled">
        <PluginCheckbox
          checked={source.enabled}
          disabled={disabled}
          onChange={(event) => onChange({ ...source, enabled: event.target.checked })}
        />
        {t('启用来源')}
      </label>
      {descriptor?.fields.map((field) => {
        const id = fieldId(source, field.key)
        const error = errors.get(`${source.draftKey}:${field.key}`)
        if (field.kind === 'select') {
          return (
            <PluginSelect
              key={field.key}
              id={id}
              label={t(field.label)}
              description={field.description}
              error={error}
              value={source.values[field.key] ?? ''}
              disabled={disabled}
              options={field.options.map((option) => ({ ...option, label: t(option.label) }))}
              onValueChange={(value) => updateValue(field.key, value ?? '')}
            />
          )
        }
        const common = {
          id,
          value: source.values[field.key] ?? '',
          disabled,
          placeholder: field.placeholder,
          onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>): void =>
            updateValue(field.key, event.target.value)
        }
        return (
          <PluginField
            key={field.key}
            label={t(field.label)}
            htmlFor={id}
            description={field.description}
            error={error}
            className={
              ['secret', 'url', 'textarea'].includes(field.kind) ? 'quota-field-wide' : undefined
            }
          >
            {field.kind === 'secret' ? (
              <PluginSecretInput {...common} />
            ) : field.kind === 'textarea' ? (
              <PluginTextarea {...common} />
            ) : (
              <PluginInput {...common} type={field.kind === 'url' ? 'url' : 'text'} />
            )}
          </PluginField>
        )
      })}
    </div>
  )
}
