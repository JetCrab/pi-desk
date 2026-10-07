import { Menu } from '@base-ui/react/menu'
import type { ReactElement, ReactNode } from 'react'
import { l4MenuPopupClassName } from '@client/l4_foundation/ui/l4-menu-styles'
import {
  DropdownMenu,
  DropdownMenuPortal,
  DropdownMenuTrigger
} from '@client/l4_foundation/ui/shadcn/dropdown-menu'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@client/l4_foundation/ui/shadcn/select'
import { useL2PiSettingsText } from '../l2-pi-settings-locale'

export function L2PiSettingsSelect({
  id,
  label,
  value,
  options,
  disabled,
  onChange
}: {
  id: string
  label: string
  value: string
  options: readonly { value: string; label: string }[]
  disabled?: boolean
  onChange: (value: string) => void
}): React.JSX.Element {
  return (
    <div className="min-w-0 space-y-1">
      <label id={`${id}-label`} htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      <Select
        value={value}
        disabled={disabled}
        onValueChange={(next) => {
          if (typeof next === 'string') onChange(next)
        }}
      >
        <SelectTrigger
          id={id}
          aria-labelledby={`${id}-label`}
          className="w-full min-w-0 whitespace-normal [&_[data-slot=select-value]]:line-clamp-none [&_[data-slot=select-value]]:break-all"
        >
          <SelectValue>
            {options.find((option) => option.value === value)?.label ?? value}
          </SelectValue>
        </SelectTrigger>
        <SelectContent positionerClassName="z-[125]" align="start">
          {options.map((option) => (
            <SelectItem
              key={option.value}
              value={option.value}
              className="[&_span]:whitespace-normal [&_span]:break-all"
            >
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}

export function L2PiSettingsMenu({
  trigger,
  children
}: {
  trigger: ReactElement
  children: ReactNode
}): React.JSX.Element {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={trigger} />
      <DropdownMenuPortal>
        <Menu.Positioner sideOffset={4} align="end" className="z-[125] outline-none">
          <Menu.Popup className={l4MenuPopupClassName}>{children}</Menu.Popup>
        </Menu.Positioner>
      </DropdownMenuPortal>
    </DropdownMenu>
  )
}

export function L2PiSettingsError({
  message,
  id
}: {
  message: string | null | undefined
  id?: string
}): React.JSX.Element | null {
  const t = useL2PiSettingsText()
  return message ? (
    <p id={id} role="alert" className="break-words text-sm text-destructive">
      {t(message)}
    </p>
  ) : null
}
