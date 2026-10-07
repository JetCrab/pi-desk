'use client'

import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import {
  createL4TerminalRenderer,
  type L4TerminalRenderer
} from '@client/l4_foundation/terminal/l4-terminal-renderer'
import type { L2TerminalBiz } from '../l2-terminal-biz'

interface TerminalScreenState {
  container: RefObject<HTMLDivElement | null>
  loading: boolean
  loadError: string | null
  control: boolean
  focus: () => void
  key: L4TerminalRenderer['key']
  toggleControl: () => void
  retry: () => void
}

export function useL2TerminalScreen(
  biz: L2TerminalBiz,
  terminalId: string,
  visible: boolean
): TerminalScreenState {
  const container = useRef<HTMLDivElement>(null)
  const renderer = useRef<L4TerminalRenderer | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [control, setControl] = useState(false)
  const [loading, setLoading] = useState(true)
  const [attempt, setAttempt] = useState(0)
  const visibility = useRef(visible)

  useLayoutEffect(() => {
    visibility.current = visible
    renderer.current?.setVisible(visible)
  }, [visible])

  useEffect(() => {
    const element = container.current
    if (!element) return
    let active = true
    const controller = new AbortController()
    let detach: (() => void) | undefined
    let instance: L4TerminalRenderer | undefined
    void createL4TerminalRenderer(element, {
      signal: controller.signal,
      onInput: (data) => {
        if (!active || !instance) return
        biz.input(terminalId, data, instance.measure())
        setControl(false)
      },
      onActivate: (dimensions) => {
        if (active) biz.activate(terminalId, dimensions)
      },
      onResize: (dimensions) => {
        if (active) biz.resize(terminalId, dimensions)
      }
    })
      .then((next) => {
        if (!active) {
          next.dispose()
          return
        }
        instance = next
        renderer.current = next
        next.setVisible(visibility.current)
        // 首次加载覆盖首帧恢复；后续同步保留已经显示的终端内容。
        detach = biz.attach(terminalId, {
          ...next,
          async restore(snapshot): Promise<void> {
            await next.restore(snapshot)
            if (active) setLoading(false)
          }
        })
      })
      .catch((cause: unknown) => {
        if (!active) return
        setLoading(false)
        setLoadError(cause instanceof Error ? cause.message : '终端加载失败')
      })
    return () => {
      active = false
      controller.abort()
      detach?.()
      renderer.current = null
      instance?.dispose()
    }
  }, [attempt, biz, terminalId])

  return {
    container,
    loading,
    loadError,
    control,
    focus: (): void => renderer.current?.focus(),
    key: (key): void => renderer.current?.key(key),
    toggleControl: (): void => {
      renderer.current?.setControl(!control)
      setControl(!control)
    },
    retry: (): void => {
      setLoading(true)
      setLoadError(null)
      setAttempt((value) => value + 1)
    }
  }
}
