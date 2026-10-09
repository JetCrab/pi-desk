'use client'

import { Settings2Icon } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@client/l4_foundation/ui/shadcn/button'
import { Popover, PopoverContent, PopoverTrigger } from '@client/l4_foundation/ui/shadcn/popover'

export function L2ModelServiceActions({
  name,
  hasAccount,
  loggedIn,
  hasCustom,
  onCustomSettings,
  onLogin,
  onLogout
}: {
  name: string
  hasAccount: boolean
  loggedIn: boolean
  hasCustom: boolean
  onCustomSettings: () => void
  onLogin: () => void
  onLogout: () => void
}): React.JSX.Element {
  const { t } = useTranslation('settings')
  const [open, setOpen] = useState(false)
  const trigger = (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      aria-label={t('serviceSettingsNamed', { name })}
      onClick={hasAccount ? undefined : onCustomSettings}
    >
      <Settings2Icon />
    </Button>
  )
  function action(callback: () => void): void {
    setOpen(false)
    callback()
  }
  if (!hasAccount) return trigger
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={trigger} />
      <PopoverContent align="end" positionerClassName="z-[120]" className="w-52 gap-1 p-1">
        <Button
          type="button"
          variant="ghost"
          className="justify-start"
          onClick={() => action(onLogin)}
        >
          {t(loggedIn ? 'accountRelogin' : 'accountLogin')}
        </Button>
        {loggedIn ? (
          <Button
            type="button"
            variant="ghost"
            className="justify-start text-destructive"
            onClick={() => action(onLogout)}
          >
            {t('accountLogout')}
          </Button>
        ) : null}
        {hasCustom ? (
          <Button
            type="button"
            variant="ghost"
            className="justify-start"
            onClick={() => action(onCustomSettings)}
          >
            {t('accountCustomSettings')}
          </Button>
        ) : null}
      </PopoverContent>
    </Popover>
  )
}
