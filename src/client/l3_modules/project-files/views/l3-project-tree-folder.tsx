'use client'

import { ChevronRightIcon, FolderIcon, FolderOpenIcon } from 'lucide-react'
import type { ComponentPropsWithRef } from 'react'
import { cn } from '@client/l4_foundation/lib/l4-utils'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger
} from '@client/l4_foundation/ui/shadcn/collapsible'
import type { L3CompactDirectory } from '../l3-project-path-tree'

export function L3ProjectTreeFolder({
  directory,
  expanded,
  onToggle,
  children,
  ...props
}: ComponentPropsWithRef<'div'> & {
  directory: L3CompactDirectory
  expanded: boolean
  onToggle: () => void
}): React.JSX.Element {
  const parts = directory.label.split('/')
  const leaf = parts.at(-1)
  const prefix = parts.slice(0, -1).join(' \\ ')
  const label = parts.join(' \\ ')
  const Icon = expanded ? FolderOpenIcon : FolderIcon

  return (
    <Collapsible open={expanded} onOpenChange={onToggle}>
      <div
        role="treeitem"
        aria-expanded={expanded}
        aria-selected={false}
        title={directory.targetPath}
        {...props}
      >
        <div className="flex min-h-9 items-center rounded-sm px-2 py-1 transition-colors hover:bg-foreground/8">
          <CollapsibleTrigger
            className="flex min-h-7 min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-sm bg-transparent p-0 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            aria-label={label}
            onKeyDown={(event) => {
              if (
                (event.key === 'ArrowLeft' && expanded) ||
                (event.key === 'ArrowRight' && !expanded)
              ) {
                event.preventDefault()
                event.stopPropagation()
                onToggle()
              }
            }}
          >
            <span className="flex size-6 shrink-0 items-center justify-center">
              <ChevronRightIcon
                className={cn(
                  'size-4 text-muted-foreground transition-transform',
                  expanded && 'rotate-90'
                )}
              />
            </span>
            <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span className="flex min-w-0 items-baseline">
              {prefix ? (
                <>
                  <span className="min-w-0 shrink-[2] truncate text-muted-foreground">
                    {prefix}
                  </span>
                  <span className="shrink-0 px-1 text-muted-foreground" aria-hidden="true">
                    {'\\'}
                  </span>
                </>
              ) : null}
              <span className="min-w-0 truncate">{leaf}</span>
            </span>
          </CollapsibleTrigger>
        </div>
        <CollapsibleContent>
          <div role="group" className="ml-4 border-l pl-2">
            {children}
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  )
}
