'use client'

import { ContextMenu as ContextMenuPrimitive } from '@base-ui/react/context-menu'
import type { ReactNode } from 'react'
import { L4ScrollArea } from '@client/l4_foundation/ui/l4-scroll-area'
import { ContextMenuPortal } from '@client/l4_foundation/ui/shadcn/context-menu'
import { cn } from '@client/l4_foundation/lib/l4-utils'
import { l4MenuPopupClassName } from '@client/l4_foundation/ui/l4-menu-styles'

export function L3FileContextMenuContent({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <ContextMenuPortal>
      {/* 文件目录和标签都可位于放大 Dialog 内；生成层未开放 Positioner 层级。 */}
      <ContextMenuPrimitive.Positioner
        className="isolate z-[130] outline-none"
        side="right"
        align="start"
        alignOffset={4}
      >
        <ContextMenuPrimitive.Popup
          data-slot="context-menu-content"
          className={cn(l4MenuPopupClassName, 'flex flex-col overflow-hidden p-0')}
        >
          <L4ScrollArea className="min-h-0" viewportClassName="p-1">
            {children}
          </L4ScrollArea>
        </ContextMenuPrimitive.Popup>
      </ContextMenuPrimitive.Positioner>
    </ContextMenuPortal>
  )
}
