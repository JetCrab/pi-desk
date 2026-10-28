'use client'

import { useEffect, useRef, useState, type MouseEvent } from 'react'
import {
  getL4DesktopWindow,
  type L4DesktopWindow,
  type L4DesktopWindowAction,
  type L4DesktopWindowState
} from './l4-desktop-window'
import './l4-desktop-window.css'

const labels = {
  'zh-CN': {
    window: '窗口',
    minimize: '最小化',
    maximize: '最大化',
    restore: '还原',
    close: '关闭'
  },
  en: {
    window: 'Window',
    minimize: 'Minimize',
    maximize: 'Maximize',
    restore: 'Restore',
    close: 'Close'
  }
}

export function L4DesktopTitlebar(): React.JSX.Element {
  const adapter = useRef<L4DesktopWindow | null>(null)
  const [state, setState] = useState<L4DesktopWindowState | null>(null)
  const [title, setTitle] = useState('Pi Desk')
  const [locale, setLocale] = useState<'zh-CN' | 'en'>('zh-CN')
  const [focused, setFocused] = useState(true)

  useEffect(() => {
    const desktop = getL4DesktopWindow()
    if (!desktop) return
    adapter.current = desktop
    let disposed = false
    let frame = 0
    const root = document.documentElement
    const readTitle = (): void => {
      setTitle(document.title || 'Pi Desk')
      setLocale(root.lang.startsWith('zh') ? 'zh-CN' : 'en')
    }
    const refreshState = (): void => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        void desktop
          .invoke('state')
          .then((next) => {
            if (!disposed) setState((current) => (current ? next : null))
          })
          .catch((error: unknown) => {
            console.error('[desktop-window] 读取窗口状态失败', error)
          })
      })
    }
    const onFocus = (): void => {
      setFocused(true)
    }
    const onBlur = (): void => {
      setFocused(false)
    }
    const observer = new MutationObserver(readTitle)
    observer.observe(document.head, { childList: true, subtree: true, characterData: true })
    observer.observe(root, { attributes: true, attributeFilter: ['lang'] })
    window.addEventListener('resize', refreshState)
    window.addEventListener('focus', onFocus)
    window.addEventListener('blur', onBlur)

    // 按钮已挂载并绑定事件后才关闭系统装饰；旧页面不会调用此能力。
    void desktop
      .invoke('attach')
      .then((next) => {
        if (disposed) return
        readTitle()
        setFocused(document.hasFocus())
        root.dataset.piDeskWindow = ''
        setState(next)
      })
      .catch((error: unknown) => {
        console.error('[desktop-window] 启用自定义标题栏失败，保留系统标题栏', error)
      })

    return () => {
      disposed = true
      adapter.current = null
      observer.disconnect()
      cancelAnimationFrame(frame)
      window.removeEventListener('resize', refreshState)
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('blur', onBlur)
      delete root.dataset.piDeskWindow
      void desktop.invoke('detach').catch((error: unknown) => {
        console.error('[desktop-window] 恢复系统标题栏失败', error)
      })
    }
  }, [])

  const run = async (action: L4DesktopWindowAction): Promise<void> => {
    const desktop = adapter.current
    if (!desktop) return
    try {
      const next = await desktop.invoke(action)
      if (adapter.current === desktop) setState(next)
    } catch (error) {
      console.error(`[desktop-window] 窗口操作失败 action=${action}`, error)
      try {
        await desktop.invoke('detach')
        if (adapter.current !== desktop) return
        delete document.documentElement.dataset.piDeskWindow
        setState(null)
      } catch (restoreError) {
        console.error('[desktop-window] 恢复系统标题栏失败', restoreError)
      }
    }
  }
  const onDrag = (event: MouseEvent<HTMLElement>): void => {
    if (event.button !== 0 || (event.target as Element).closest('button')) return
    event.preventDefault()
    void run(event.detail === 2 ? 'toggle-maximize' : 'drag')
  }
  const text = labels[locale]
  const maximizeLabel = state?.maximized ? text.restore : text.maximize

  return (
    <header
      className="pi-desk-titlebar"
      data-testid="desktop-titlebar"
      data-focused={focused}
      hidden={!state}
      aria-label={text.window}
      onMouseDown={onDrag}
    >
      <span className="pi-desk-titlebar-title" title={title}>
        {title}
      </span>
      <div className="pi-desk-titlebar-controls">
        <button
          type="button"
          aria-label={text.minimize}
          title={text.minimize}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            void run('minimize')
          }}
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M3 8.5h10" />
          </svg>
        </button>
        <button
          type="button"
          aria-label={maximizeLabel}
          title={maximizeLabel}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            void run('toggle-maximize')
          }}
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            {state?.maximized ? (
              <path d="M5.5 5.5v-3h8v8h-3m-8-5h8v8h-8z" />
            ) : (
              <rect x="3.5" y="3.5" width="9" height="9" />
            )}
          </svg>
        </button>
        <button
          type="button"
          className="pi-desk-titlebar-close"
          aria-label={text.close}
          title={text.close}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            void run('close')
          }}
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="m3.5 3.5 9 9m0-9-9 9" />
          </svg>
        </button>
      </div>
    </header>
  )
}
