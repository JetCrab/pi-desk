'use client'

import { Toast } from '@base-ui/react/toast'
import { CheckCircle2Icon, CircleAlertIcon, InfoIcon, TriangleAlertIcon, XIcon } from 'lucide-react'
import { useMemo, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  BrowserNotificationInput,
  BrowserNotificationLevel
} from '@jetcrab/pi-desk-sdk/browser'
import { cn } from '@client/l4_foundation/lib/l4-utils'

interface L4AppToastData {
  level: BrowserNotificationLevel
}

function toastIcon(level: BrowserNotificationLevel): React.JSX.Element {
  if (level === 'error') {
    return <CircleAlertIcon className="mt-0.5 size-4 shrink-0 text-destructive" />
  }
  if (level === 'warning') {
    return <TriangleAlertIcon className="mt-0.5 size-4 shrink-0 text-status-warning" />
  }
  if (level === 'success') {
    return <CheckCircle2Icon className="mt-0.5 size-4 shrink-0 text-status-success" />
  }
  return <InfoIcon className="mt-0.5 size-4 shrink-0 text-primary" />
}

function L4AppToastList(): React.JSX.Element {
  const { t } = useTranslation('common')
  const manager = Toast.useToastManager<L4AppToastData>()

  return (
    <>
      {manager.toasts.slice(0, 3).map((toast) => {
        const level = toast.data?.level ?? 'info'
        return (
          <Toast.Root
            key={toast.id}
            toast={toast}
            data-pi-desk-toast={level}
            className={cn(
              'pointer-events-auto flex w-full items-start gap-3 rounded-xl border bg-popover px-3 py-3 text-popover-foreground shadow-md transition-[transform,opacity] duration-200 data-starting-style:translate-y-2 data-starting-style:opacity-0 data-ending-style:translate-y-2 data-ending-style:opacity-0',
              level === 'error'
                ? 'border-destructive/40'
                : level === 'warning'
                  ? 'border-status-warning/40'
                  : 'border-border'
            )}
          >
            {toastIcon(level)}
            <div className="min-w-0 flex-1">
              <Toast.Title className="text-sm leading-5 font-medium" />
              <Toast.Description className="mt-1 text-sm leading-5 text-muted-foreground" />
            </div>
            <Toast.Close
              aria-label={t('closeNotice')}
              title={t('closeNotice')}
              className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            >
              <XIcon className="size-3.5" />
            </Toast.Close>
          </Toast.Root>
        )
      })}
    </>
  )
}

export function L4AppToastProvider({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <Toast.Provider timeout={3000} limit={3}>
      {children}
      <Toast.Portal>
        <Toast.Viewport className="fixed right-3 bottom-3 z-[200] flex w-[min(24rem,calc(100vw-1.5rem))] flex-col gap-2 outline-none sm:right-5 sm:bottom-5">
          <L4AppToastList />
        </Toast.Viewport>
      </Toast.Portal>
    </Toast.Provider>
  )
}

export function useL4AppToast(): {
  show: (input: BrowserNotificationInput) => string
  success: (message: string) => string
  error: (message: string) => string
} {
  const { add } = Toast.useToastManager<L4AppToastData>()
  const { t } = useTranslation('common')
  return useMemo(() => {
    const show = (input: BrowserNotificationInput): string => {
      const title = input.title.trim().slice(0, 120)
      const description = input.description?.trim().slice(0, 320)
      return add({
        title: title || t('pluginNotice'),
        ...(description ? { description } : {}),
        type: input.level,
        ...(input.level === 'error' || input.level === 'warning' ? { priority: 'high' } : {}),
        data: { level: input.level }
      })
    }

    return {
      show,
      success: (message: string) => show({ level: 'success', title: message }),
      error: (message: string) => show({ level: 'error', title: message })
    }
  }, [add, t])
}
