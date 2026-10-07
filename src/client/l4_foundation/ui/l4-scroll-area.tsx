'use client'

import * as React from 'react'
import { ScrollArea as ScrollAreaPrimitive } from '@base-ui/react/scroll-area'
import { cn } from '@client/l4_foundation/lib/l4-utils'
import { ScrollBar } from './shadcn/scroll-area'

export type L4ScrollAreaProps = ScrollAreaPrimitive.Root.Props & {
  viewportClassName?: string
  viewportRef?: React.Ref<HTMLDivElement>
  onViewportScroll?: React.UIEventHandler<HTMLDivElement>
}

export function L4ScrollArea({
  className,
  viewportClassName,
  viewportRef,
  onViewportScroll,
  children,
  ...props
}: L4ScrollAreaProps): React.JSX.Element {
  return (
    <ScrollAreaPrimitive.Root
      data-slot="l4-scroll-area"
      className={cn('relative min-h-0 overflow-hidden', className)}
      {...props}
    >
      <ScrollAreaPrimitive.Viewport
        ref={viewportRef}
        data-slot="l4-scroll-area-viewport"
        className={cn(
          'size-full rounded-[inherit] outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-1',
          viewportClassName
        )}
        onScroll={onViewportScroll}
      >
        {children}
      </ScrollAreaPrimitive.Viewport>
      <ScrollBar className="data-[orientation=vertical]:h-full data-[orientation=vertical]:w-2.5 data-[orientation=vertical]:border-l data-[orientation=vertical]:border-l-transparent" />
      <ScrollAreaPrimitive.Corner />
    </ScrollAreaPrimitive.Root>
  )
}
