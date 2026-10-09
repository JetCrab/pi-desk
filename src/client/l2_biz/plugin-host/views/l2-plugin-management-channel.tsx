'use client'

import { useTranslation } from 'react-i18next'
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
  onChange: (value: string) => void
}

export function L2PluginManagementChannel({
  value,
  label,
  placeholder,
  disabled,
  onChange
}: ChannelProps): React.JSX.Element {
  const { t } = useTranslation('pluginManagement')
  const options = [
    ...(placeholder ? [{ value: '', label: placeholder }] : []),
    { value: 'latest', label: t('channelLatest') },
    { value: 'dev', label: t('channelDev') }
  ]
  return (
    <Select
      value={value}
      items={options}
      disabled={disabled}
      onValueChange={(next) => {
        if (next !== null) onChange(next)
      }}
    >
      <SelectTrigger aria-label={label} className="max-w-full">
        <SelectValue />
      </SelectTrigger>
      <SelectContent positionerClassName="z-[160]">
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
