'use client'

import { Check, Copy } from 'lucide-react'
import { useEffect, useRef, useState, type ReactElement } from 'react'
import { Button } from '@client/l4_foundation/ui/shadcn/button'

export function CopyCommandButton({
  label,
  command,
  variant = 'ghost',
  iconOnly = false
}: {
  label: string
  command: string
  variant?: 'default' | 'secondary' | 'ghost'
  iconOnly?: boolean
}): ReactElement {
  const [status, setStatus] = useState<'idle' | 'copied' | 'failed'>('idle')
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    []
  )

  async function copy(): Promise<void> {
    if (timer.current) clearTimeout(timer.current)
    try {
      await navigator.clipboard.writeText(command)
      setStatus('copied')
      timer.current = setTimeout(() => setStatus('idle'), 2000)
    } catch (error) {
      console.warn('官网命令复制失败', error)
      setStatus('failed')
    }
  }

  return (
    <div>
      <Button
        variant={variant}
        size={iconOnly ? 'icon' : 'default'}
        aria-label={label}
        onClick={() => void copy()}
      >
        {status === 'copied' ? <Check /> : <Copy />}
        {!iconOnly && label}
      </Button>
      <span
        className={status === 'failed' ? 'mt-1 block text-xs text-destructive' : 'sr-only'}
        role="status"
      >
        {status === 'copied'
          ? '已复制'
          : status === 'failed'
            ? '复制失败，请选择命令后手动复制。'
            : ''}
      </span>
    </div>
  )
}

export function Command({ label, command }: { label: string; command: string }): ReactElement {
  return (
    <section aria-label={label} className="space-y-2">
      <h2 className="text-sm font-medium">{label}</h2>
      <div className="flex min-h-11 items-center gap-3 rounded-lg bg-muted pr-2 pl-4">
        <code className="min-w-0 flex-1 overflow-x-auto font-mono text-sm leading-6 whitespace-nowrap">
          {command}
        </code>
        <CopyCommandButton label={`复制${label}`} command={command} iconOnly />
      </div>
    </section>
  )
}
