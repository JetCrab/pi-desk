'use client'

import { Check, Copy } from 'lucide-react'
import { useEffect, useRef, useState, type ReactElement } from 'react'
import { Button } from '@client/l4_foundation/ui/shadcn/button'

export function Command({ label, command }: { label: string; command: string }): ReactElement {
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
      <div className="flex min-h-9 items-center gap-3 rounded-lg bg-muted py-0.5 pr-1 pl-3">
        <span className="shrink-0 text-xs text-muted-foreground">{label}</span>
        <code className="min-w-0 flex-1 font-mono text-xs leading-relaxed wrap-anywhere">
          {command}
        </code>
        <Button variant="ghost" size="icon" aria-label={`复制${label}`} onClick={() => void copy()}>
          {status === 'copied' ? <Check /> : <Copy />}
        </Button>
      </div>
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
