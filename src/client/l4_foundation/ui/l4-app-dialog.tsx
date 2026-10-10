'use client'

import * as React from 'react'
import { Dialog as DialogPrimitive } from '@base-ui/react/dialog'
import { ScrollArea as ScrollAreaPrimitive } from '@base-ui/react/scroll-area'
import { XIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { cn } from '@client/l4_foundation/lib/l4-utils'

function L4AppDialogRoot({
  onOpenChange,
  ...props
}: DialogPrimitive.Root.Props): React.JSX.Element {
  return (
    <DialogPrimitive.Root
      data-slot="app-dialog"
      {...props}
      onOpenChange={(open, eventDetails) => {
        // Portal 在按下与松开之间覆盖触发器时，浏览器会把 click 派发给 BODY。
        // Base UI 已校验遮罩归属；宿主模态弹窗只接受实际命中遮罩的关闭请求。
        if (
          !open &&
          props.modal !== false &&
          eventDetails.reason === 'outside-press' &&
          (!(eventDetails.event.target instanceof Element) ||
            eventDetails.event.target.getAttribute('data-slot') !== 'app-dialog-backdrop')
        ) {
          eventDetails.cancel()
          return
        }
        onOpenChange?.(open, eventDetails)
      }}
    />
  )
}

function L4AppDialogTrigger({ ...props }: DialogPrimitive.Trigger.Props): React.JSX.Element {
  return <DialogPrimitive.Trigger data-slot="app-dialog-trigger" {...props} />
}

function L4AppDialogPortal({ ...props }: DialogPrimitive.Portal.Props): React.JSX.Element {
  return <DialogPrimitive.Portal data-slot="app-dialog-portal" {...props} />
}

function L4AppDialogClose({ ...props }: DialogPrimitive.Close.Props): React.JSX.Element {
  return <DialogPrimitive.Close data-slot="app-dialog-close" {...props} />
}

function L4AppDialogBackdrop({
  className,
  ...props
}: DialogPrimitive.Backdrop.Props): React.JSX.Element {
  return (
    <DialogPrimitive.Backdrop
      data-slot="app-dialog-backdrop"
      className={cn(
        'fixed inset-0 z-[100] bg-black/35 duration-100 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0',
        className
      )}
      {...props}
    />
  )
}

function L4AppDialogContent({
  className,
  children,
  showCloseButton = true,
  finalFocus = false,
  backdropClassName,
  ...props
}: DialogPrimitive.Popup.Props & {
  showCloseButton?: boolean
  backdropClassName?: string
}): React.JSX.Element {
  const { t } = useTranslation('common')
  return (
    <L4AppDialogPortal>
      <L4AppDialogBackdrop className={backdropClassName} forceRender={Boolean(backdropClassName)} />
      <DialogPrimitive.Popup
        data-slot="app-dialog-content"
        finalFocus={finalFocus}
        className={cn(
          'fixed top-1/2 left-1/2 z-[110] flex max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-[27.5rem] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-border bg-popover text-sm text-popover-foreground shadow-lg outline-none duration-100 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95',
          className
        )}
        {...props}
      >
        {children}
        {showCloseButton ? (
          <DialogPrimitive.Close
            data-slot="app-dialog-close-button"
            aria-label={t('closeDialog')}
            title={t('closeDialog')}
            className="absolute top-2 right-2 flex size-8 cursor-pointer items-center justify-center rounded-lg text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground active:bg-foreground/14 focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
          >
            <XIcon className="size-4" />
            <span className="sr-only">{t('closeDialog')}</span>
          </DialogPrimitive.Close>
        ) : null}
      </DialogPrimitive.Popup>
    </L4AppDialogPortal>
  )
}

function L4AppDialogHeader({
  className,
  ...props
}: React.ComponentProps<'div'>): React.JSX.Element {
  return (
    <div
      data-slot="app-dialog-header"
      className={cn('flex shrink-0 flex-col gap-1.5', className)}
      {...props}
    />
  )
}

function L4AppDialogBody({
  className,
  children,
  ...props
}: ScrollAreaPrimitive.Root.Props): React.JSX.Element {
  return (
    <ScrollAreaPrimitive.Root
      data-slot="app-dialog-body"
      className={cn('relative min-h-0 flex-1 overflow-hidden', className)}
      {...props}
    >
      <ScrollAreaPrimitive.Viewport
        data-slot="app-dialog-body-viewport"
        className="h-full max-h-[inherit] w-full overscroll-contain rounded-[inherit] outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {children}
      </ScrollAreaPrimitive.Viewport>
      <ScrollAreaPrimitive.Scrollbar
        data-slot="app-dialog-body-scrollbar"
        orientation="vertical"
        className="flex h-full w-2.5 touch-none border-l border-l-transparent p-px select-none"
      >
        <ScrollAreaPrimitive.Thumb
          data-slot="app-dialog-body-thumb"
          className="relative flex-1 rounded-full bg-muted-foreground/45 hover:bg-muted-foreground/70"
        />
      </ScrollAreaPrimitive.Scrollbar>
      <ScrollAreaPrimitive.Corner />
    </ScrollAreaPrimitive.Root>
  )
}

function L4AppDialogFooter({
  className,
  ...props
}: React.ComponentProps<'div'>): React.JSX.Element {
  return (
    <div
      data-slot="app-dialog-footer"
      className={cn(
        'flex shrink-0 flex-wrap justify-end gap-2 border-t bg-popover px-4 py-3',
        className
      )}
      {...props}
    />
  )
}

function L4AppDialogTitle({ className, ...props }: DialogPrimitive.Title.Props): React.JSX.Element {
  return (
    <DialogPrimitive.Title
      data-slot="app-dialog-title"
      className={cn('text-lg leading-[1.4] font-semibold', className)}
      {...props}
    />
  )
}

function L4AppDialogDescription({
  className,
  ...props
}: DialogPrimitive.Description.Props): React.JSX.Element {
  return (
    <DialogPrimitive.Description
      data-slot="app-dialog-description"
      className={cn('text-sm leading-5 text-muted-foreground', className)}
      {...props}
    />
  )
}

export {
  L4AppDialogBackdrop,
  L4AppDialogBody,
  L4AppDialogClose,
  L4AppDialogContent,
  L4AppDialogDescription,
  L4AppDialogFooter,
  L4AppDialogHeader,
  L4AppDialogPortal,
  L4AppDialogRoot,
  L4AppDialogTitle,
  L4AppDialogTrigger
}
