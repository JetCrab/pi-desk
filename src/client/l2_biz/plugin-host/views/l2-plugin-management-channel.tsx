'use client'

import { useTranslation } from 'react-i18next'
import { Button } from '@client/l4_foundation/ui/shadcn/button'
import { L4LoadingState } from '@client/l4_foundation/ui/loading/l4-loading-state'
import type { L2PluginDevAvailability } from '../hooks/l2-use-plugin-dev-availability'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@client/l4_foundation/ui/shadcn/select'

interface ChannelProps {
  value: string
  label: string
  placeholder?: string
  disabled?: boolean
  dev: L2PluginDevAvailability
  onChange: (value: string) => void
}

export function L2PluginManagementChannel({
  value,
  label,
  placeholder,
  disabled,
  dev,
  onChange
}: ChannelProps): React.JSX.Element {
  const { t } = useTranslation('pluginManagement')
  const options = [
    ...(placeholder ? [{ value: '', label: placeholder }] : []),
    { value: 'latest', label: t('channelLatest') },
    ...(dev.version
      ? [{ value: 'dev', label: t('channelDev') }]
      : value === 'dev'
        ? [{ value: 'dev', label: t('channelDevUnverified') }]
        : []),
    ...(value && !['latest', 'dev'].includes(value) ? [{ value, label: value }] : [])
  ]
  return (
    <div className="min-w-0 space-y-1">
      <Select
        value={value}
        items={options}
        onOpenChange={(open, details) => {
          if (open && disabled) details.cancel()
        }}
        onValueChange={(next) => {
          if (next !== null && !disabled && (next !== 'dev' || dev.version)) onChange(next)
        }}
      >
        <SelectTrigger
          aria-label={label}
          aria-disabled={disabled}
          className="max-w-full aria-disabled:opacity-50"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent positionerClassName="z-[160]">
          {options.map((option) => (
            <SelectItem
              key={option.value}
              value={option.value}
              disabled={disabled || (option.value === 'dev' && !dev.version)}
            >
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {dev.loading ? (
        <L4LoadingState compact className="justify-start text-xs">
          {t('checkingDev')}
        </L4LoadingState>
      ) : null}
      {dev.error ? (
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span title={dev.error}>{dev.retry ? t('devUnverified') : dev.error}</span>
          {dev.retry ? (
            <Button size="sm" variant="ghost" disabled={disabled} onClick={dev.retry}>
              {t('retry')}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
