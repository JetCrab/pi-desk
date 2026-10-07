'use client'

import { useEffect, useRef, useState } from 'react'
import type { L2ChatSource } from '@common/l2_biz/chat/l2-chat-contract'
import type { L2PiModelOption } from '@common/l2_biz/pi-model/l2-pi-model-contract'
import type { L2WorkbenchChatInputRuntime } from '../l2-workbench-chat-input-runtime'

export function useL2WorkbenchModelPicker(
  source: L2ChatSource,
  runtime: L2WorkbenchChatInputRuntime,
  disabled: boolean
): {
  open: boolean
  pending: boolean
  error: string | null
  changeOpen: (open: boolean) => void
  refresh: () => void
  submit: (
    model: Pick<L2PiModelOption, 'provider' | 'modelId'>,
    level: L2PiModelOption['thinkingLevels'][number]
  ) => Promise<void>
} {
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const panel = useRef<object | null>(null)
  const submitting = useRef(false)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      panel.current = null
    }
  }, [])
  const refresh = (): void => {
    void runtime.loadModels(source, true)
  }
  const changeOpen = (next: boolean): void => {
    panel.current = next ? {} : null
    setOpen(next)
    if (next) {
      setError(null)
      refresh()
    }
  }
  const submit = async (
    model: Pick<L2PiModelOption, 'provider' | 'modelId'>,
    level: L2PiModelOption['thinkingLevels'][number]
  ): Promise<void> => {
    if (disabled || submitting.current) return
    const origin = panel.current
    submitting.current = true
    setPending(true)
    setError(null)
    try {
      await runtime.setModel(source, {
        provider: model.provider,
        modelId: model.modelId,
        thinkingLevel: level
      })
      if (origin && panel.current === origin) changeOpen(false)
    } catch (cause) {
      if (origin && panel.current === origin)
        setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      submitting.current = false
      if (mounted.current) setPending(false)
    }
  }
  return { open, pending, error, changeOpen, refresh, submit }
}
