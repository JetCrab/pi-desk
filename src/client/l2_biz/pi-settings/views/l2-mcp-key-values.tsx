import { PlusIcon, Trash2Icon } from 'lucide-react'
import { Button } from '@client/l4_foundation/ui/shadcn/button'
import { Input } from '@client/l4_foundation/ui/shadcn/input'
import type { L2McpKeyValue } from '../l2-pi-settings-model'
import { useL2PiSettingsText } from '../l2-pi-settings-locale'
import { L2PiSettingsError } from './l2-pi-settings-fields'

export function L2McpKeyValues({
  id,
  label,
  rows,
  disabled,
  error,
  onChange
}: {
  id: string
  label: string
  rows: L2McpKeyValue[]
  disabled: boolean
  error: string | null
  onChange: (rows: L2McpKeyValue[]) => void
}): React.JSX.Element {
  const t = useL2PiSettingsText()
  return (
    <fieldset className="min-w-0 space-y-2" disabled={disabled}>
      <legend className="text-sm font-medium">{label}</legend>
      {rows.length > 0 && (
        <div
          className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)_2rem] gap-2 text-xs text-muted-foreground"
          aria-hidden="true"
        >
          <span>{t('名称')}</span>
          <span>{t('值')}</span>
        </div>
      )}
      {rows.map((row, index) => (
        <div key={index} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)_2rem] gap-2">
          <Input
            aria-label={`${label} · ${t('名称')} ${index + 1}`}
            aria-invalid={Boolean(error)}
            aria-describedby={error ? `${id}-error` : undefined}
            value={row.key}
            spellCheck={false}
            className="min-w-0 font-mono"
            onChange={(event) =>
              onChange(
                rows.map((item, itemIndex) =>
                  itemIndex === index ? { ...item, key: event.target.value } : item
                )
              )
            }
          />
          <Input
            aria-label={`${label} · ${t('值')} ${index + 1}`}
            value={row.value}
            spellCheck={false}
            autoComplete="off"
            className="min-w-0 font-mono"
            onChange={(event) =>
              onChange(
                rows.map((item, itemIndex) =>
                  itemIndex === index ? { ...item, value: event.target.value } : item
                )
              )
            }
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={`${t('删除行')} · ${label} ${index + 1}`}
            disabled={disabled}
            onClick={() => onChange(rows.filter((_, itemIndex) => itemIndex !== index))}
          >
            <Trash2Icon aria-hidden="true" />
          </Button>
        </div>
      ))}
      <L2PiSettingsError id={`${id}-error`} message={error} />
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={disabled}
        onClick={() => onChange([...rows, { key: '', value: '' }])}
      >
        <PlusIcon aria-hidden="true" />
        {t('添加')}
        {label}
      </Button>
    </fieldset>
  )
}
