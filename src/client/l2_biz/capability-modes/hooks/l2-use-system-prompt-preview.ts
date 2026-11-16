import { useCallback, useEffect, useRef, useState } from 'react'
import type { L2ChatSource } from '@common/l2_biz/chat/l2-chat-contract'
import type { L2ChatModelContextGetResponse } from '@common/l2_biz/chat/l2-chat-context-contract'
import type { L2CapabilityModesBiz } from '../l2-capability-modes-biz'

interface PreviewState {
  identity: string
  loading: boolean
  error: string | null
  value: L2ChatModelContextGetResponse | null
}

interface SystemPromptPreview {
  loading: boolean
  error: string | null
  value: L2ChatModelContextGetResponse | null
  request(content: string): Promise<void>
}

export function useL2SystemPromptPreview(
  biz: L2CapabilityModesBiz,
  source: L2ChatSource | null,
  fallbackError: string
): SystemPromptPreview {
  const identity = JSON.stringify(source)
  const [state, setState] = useState<PreviewState | null>(null)
  const active = useRef<AbortController | null>(null)
  useEffect(() => {
    return (): void => {
      active.current?.abort()
    }
  }, [identity])

  const request = useCallback(
    async (content: string): Promise<void> => {
      if (!source) return
      active.current?.abort()
      const controller = new AbortController()
      active.current = controller
      setState({ identity, loading: true, error: null, value: null })
      try {
        const value = await biz.preview(source, content, controller.signal)
        if (!controller.signal.aborted) setState({ identity, loading: false, error: null, value })
      } catch (cause) {
        if (!controller.signal.aborted)
          setState({
            identity,
            loading: false,
            value: null,
            error: cause instanceof Error ? cause.message : fallbackError
          })
      }
    },
    [biz, fallbackError, identity, source]
  )
  const visible = state?.identity === identity ? state : null
  return {
    loading: visible?.loading ?? false,
    error: visible?.error ?? null,
    value: visible?.value ?? null,
    request
  }
}
