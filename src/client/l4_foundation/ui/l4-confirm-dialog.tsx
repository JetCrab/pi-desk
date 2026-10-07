'use client'

import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  L4AppDialogContent,
  L4AppDialogDescription,
  L4AppDialogFooter,
  L4AppDialogHeader,
  L4AppDialogRoot,
  L4AppDialogTitle
} from './l4-app-dialog'
import { Button } from './shadcn/button'

interface ConfirmOptions {
  title: string
  description: string
  confirmLabel?: string
}

export function useL4ConfirmDialog(): {
  confirm: (options: ConfirmOptions) => Promise<boolean>
  dialog: React.JSX.Element | null
} {
  const { t } = useTranslation('common')
  const [options, setOptions] = useState<ConfirmOptions | null>(null)
  const resolveRef = useRef<((confirmed: boolean) => void) | null>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)

  useEffect(
    () => () => {
      resolveRef.current?.(false)
      resolveRef.current = null
    },
    []
  )

  const settle = (confirmed: boolean): void => {
    const resolve = resolveRef.current
    resolveRef.current = null
    setOptions(null)
    resolve?.(confirmed)
  }

  const confirm = (nextOptions: ConfirmOptions): Promise<boolean> => {
    // 每个调用方同时仅持有一个确认，替换和卸载均按取消收敛。
    resolveRef.current?.(false)
    setOptions(nextOptions)
    return new Promise((resolve) => {
      resolveRef.current = resolve
    })
  }

  return {
    confirm,
    dialog: options ? (
      <L4AppDialogRoot
        open
        onOpenChange={(open) => {
          if (!open) settle(false)
        }}
      >
        <L4AppDialogContent initialFocus={cancelRef} className="z-[130] max-w-[27.5rem]">
          <L4AppDialogHeader className="p-4 pr-12">
            <L4AppDialogTitle>{options.title}</L4AppDialogTitle>
            <L4AppDialogDescription className="break-words">
              {options.description}
            </L4AppDialogDescription>
          </L4AppDialogHeader>
          <L4AppDialogFooter>
            <Button ref={cancelRef} variant="outline" onClick={() => settle(false)}>
              {t('cancel')}
            </Button>
            <Button variant="destructive" onClick={() => settle(true)}>
              {options.confirmLabel ?? t('delete')}
            </Button>
          </L4AppDialogFooter>
        </L4AppDialogContent>
      </L4AppDialogRoot>
    ) : null
  }
}
