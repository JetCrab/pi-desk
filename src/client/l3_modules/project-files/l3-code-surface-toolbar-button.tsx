'use client'

import type { ReactNode } from 'react'
import { Button } from '@client/l4_foundation/ui/shadcn/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@client/l4_foundation/ui/shadcn/tooltip'

interface L3CodeSurfaceToolbarButtonProps {
  label: string
  onClick: () => void
  active?: boolean
  children: ReactNode
}

export function L3CodeSurfaceToolbarButton({
  label,
  onClick,
  active = false,
  children
}: L3CodeSurfaceToolbarButtonProps): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label={label}
            aria-pressed={active || undefined}
            onPointerDown={(event) => event.preventDefault()}
            onClick={onClick}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}
