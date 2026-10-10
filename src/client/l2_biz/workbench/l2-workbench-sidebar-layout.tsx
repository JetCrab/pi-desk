'use client'

import { useLayoutEffect, useRef, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { usePanelRef } from 'react-resizable-panels'
import { cn } from '@client/l4_foundation/lib/l4-utils'
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup
} from '@client/l4_foundation/ui/shadcn/resizable'
import motion from './l2-workbench-motion.module.css'

interface L2WorkbenchSidebarLayoutProps {
  mobile: boolean
  open: boolean
  sidebar: ReactNode
  children: ReactNode
  onClose: () => void
}

export function L2WorkbenchSidebarLayout({
  mobile,
  open,
  sidebar,
  children,
  onClose
}: L2WorkbenchSidebarLayoutProps): React.JSX.Element {
  const { t } = useTranslation('workbench')
  const sidebarRef = usePanelRef()
  const expandedWidthRef = useRef(288)

  useLayoutEffect(() => {
    if (mobile) return
    // 等 Panel 约束更新后恢复用户列宽，不重建侧栏或聊天实例。
    const frame = requestAnimationFrame(() => {
      sidebarRef.current?.resize(open ? expandedWidthRef.current : 0)
    })
    return () => cancelAnimationFrame(frame)
  }, [mobile, open, sidebarRef])

  if (mobile) {
    return (
      <>
        <button
          type="button"
          aria-label={t('closeSessionMenu')}
          aria-hidden={!open}
          tabIndex={open ? 0 : -1}
          onClick={onClose}
          className={cn(
            motion.backdrop,
            'fixed inset-0 z-40 bg-black/35',
            open ? 'opacity-100' : 'pointer-events-none opacity-0'
          )}
        />
        <div
          data-testid="mobile-work-session-drawer"
          data-open={open}
          aria-hidden={!open || undefined}
          inert={!open || undefined}
          className={cn(
            motion.drawer,
            'fixed inset-y-0 left-0 z-50 flex w-[min(86vw,320px)] flex-col border-r bg-sidebar shadow-2xl',
            !open && 'pointer-events-none'
          )}
        >
          {sidebar}
        </div>
        <div className="flex min-h-0 min-w-0 flex-1" inert={open || undefined}>
          {children}
        </div>
      </>
    )
  }

  return (
    <ResizablePanelGroup
      orientation="horizontal"
      disableCursor
      className={cn(motion.panelGroup, 'pi-desk-workbench-resize-group min-h-0 min-w-0 flex-1')}
      onLayoutChanged={(_layout, meta) => {
        if (!meta.isUserInteraction || !open) return
        const width = sidebarRef.current?.getSize().inPixels
        if (width !== undefined) expandedWidthRef.current = width
      }}
    >
      <ResizablePanel
        id="work-session-sidebar"
        panelRef={sidebarRef}
        defaultSize={288}
        minSize={open ? 224 : 0}
        maxSize={open ? 480 : 0}
        disabled={!open}
        aria-hidden={!open || undefined}
        inert={!open || undefined}
        className="flex h-full min-h-0 min-w-0 !overflow-hidden bg-sidebar"
      >
        <div className="flex h-full w-full min-w-[224px] flex-col border-r">{sidebar}</div>
      </ResizablePanel>
      <ResizableHandle
        withHandle
        aria-label={t('resizeSessionList')}
        aria-hidden={!open || undefined}
        disabled={!open}
        className={cn('cursor-col-resize', !open && 'w-0 pointer-events-none opacity-0')}
      />
      <ResizablePanel
        id="work-session-content"
        minSize={360}
        className="flex h-full min-h-0 min-w-0 !overflow-hidden"
      >
        {children}
      </ResizablePanel>
    </ResizablePanelGroup>
  )
}
