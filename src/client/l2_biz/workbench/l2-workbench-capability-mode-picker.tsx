import { ChevronDownIcon, ListFilterIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { L3CapabilityModeNames } from '@common/l3_modules/capability-modes/l3-capability-modes-contract'
import { Button } from '@client/l4_foundation/ui/shadcn/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger
} from '@client/l4_foundation/ui/shadcn/dropdown-menu'

export function L2WorkbenchCapabilityModePicker({
  modes,
  value,
  disabled,
  onChange
}: {
  modes: L3CapabilityModeNames
  value: string | null
  disabled: boolean
  onChange: (key: string | null) => void
}): React.JSX.Element | null {
  const { t } = useTranslation('capabilityModes')
  if (Object.keys(modes).length === 0) return null
  const label =
    value === null
      ? t('allEnabled')
      : Object.hasOwn(modes, value)
        ? modes[value]
        : t('modeSwitching')
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            disabled={disabled}
            aria-label={t('modePicker', { name: label })}
            className="min-w-0 max-w-40 text-muted-foreground"
          />
        }
      >
        <ListFilterIcon className="size-4 shrink-0" />
        <span className="min-w-0 truncate">{label}</span>
        <ChevronDownIcon className="size-3 shrink-0" />
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="max-h-80 min-w-40 overflow-y-auto">
        <DropdownMenuRadioGroup
          value={value ?? ''}
          onValueChange={(key) => onChange(typeof key === 'string' && key ? key : null)}
        >
          <DropdownMenuRadioItem value="">{t('allEnabled')}</DropdownMenuRadioItem>
          {Object.entries(modes).map(([key, name]) => (
            <DropdownMenuRadioItem key={key} value={key}>
              {name}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
