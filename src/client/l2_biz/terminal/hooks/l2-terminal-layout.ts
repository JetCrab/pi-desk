'use client'

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { usePanelRef } from 'react-resizable-panels'
import type { L2TerminalBiz } from '../l2-terminal-biz'

interface DockPreferences {
  dock: 'bottom' | 'right'
  height: number
  width: number
}

const DEFAULT_DOCK: DockPreferences = { dock: 'bottom', height: 280, width: 440 }
const STORAGE_KEY = 'pi-desk-terminal-dock'

function loadPreferences(): DockPreferences {
  try {
    const value = JSON.parse(
      localStorage.getItem(STORAGE_KEY) ?? 'null'
    ) as Partial<DockPreferences> | null
    return {
      dock: value?.dock === 'right' ? 'right' : 'bottom',
      height:
        typeof value?.height === 'number'
          ? Math.max(160, Math.min(1200, value.height))
          : DEFAULT_DOCK.height,
      width:
        typeof value?.width === 'number'
          ? Math.max(240, Math.min(1600, value.width))
          : DEFAULT_DOCK.width
    }
  } catch {
    return DEFAULT_DOCK
  }
}

interface TerminalLayout {
  root: RefObject<HTMLDivElement | null>
  terminalPanel: ReturnType<typeof usePanelRef>
  preferences: DockPreferences
  right: boolean
  maximized: boolean
  pageVisible: boolean
  setDock: () => void
  toggleMaximized: () => void
  saveSize: () => void
  collapse: () => void
  expand: () => void
}

export function useL2TerminalLayout(
  biz: L2TerminalBiz,
  mobile: boolean,
  expanded: boolean
): TerminalLayout {
  const [preferences, setPreferences] = useState(DEFAULT_DOCK)
  const [loaded, setLoaded] = useState(false)
  const [maximized, setMaximized] = useState(false)
  const [pageVisible, setPageVisible] = useState(true)
  const terminalPanel = usePanelRef()
  const root = useRef<HTMLDivElement>(null)
  const lastFocus = useRef<HTMLElement | null>(null)
  const right = !mobile && preferences.dock === 'right'

  useEffect(() => {
    let active = true
    queueMicrotask(() => {
      if (!active) return
      setPreferences(loadPreferences())
      setLoaded(true)
    })
    return () => {
      active = false
    }
  }, [])
  useEffect(() => {
    if (!loaded) return
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences))
    } catch {
      /* 偏好可丢弃，不影响 Shell。 */
    }
  }, [loaded, preferences])

  useLayoutEffect(() => {
    const frame = requestAnimationFrame(() => {
      terminalPanel.current?.resize(
        expanded
          ? mobile || maximized
            ? '100%'
            : right
              ? preferences.width
              : preferences.height
          : 0
      )
    })
    return () => cancelAnimationFrame(frame)
  }, [expanded, maximized, mobile, preferences, right, terminalPanel])

  useLayoutEffect(() => {
    if (!mobile) return
    const viewport = window.visualViewport
    const update = (): void => {
      const element = root.current
      if (!element) return
      const top = element.getBoundingClientRect().top
      const visibleBottom = (viewport?.offsetTop ?? 0) + (viewport?.height ?? window.innerHeight)
      element.style.setProperty(
        '--terminal-visible-height',
        `${Math.max(120, visibleBottom - top)}px`
      )
    }
    update()
    viewport?.addEventListener('resize', update)
    viewport?.addEventListener('scroll', update)
    window.addEventListener('resize', update)
    return () => {
      viewport?.removeEventListener('resize', update)
      viewport?.removeEventListener('scroll', update)
      window.removeEventListener('resize', update)
    }
  }, [mobile])

  useEffect(() => {
    const update = (): void => {
      const visible = document.visibilityState === 'visible'
      biz.setPageVisible(visible)
      setPageVisible(visible)
    }
    update()
    document.addEventListener('visibilitychange', update)
    return () => document.removeEventListener('visibilitychange', update)
  }, [biz])

  const collapse = useCallback((): void => {
    biz.setExpanded(false)
    if (lastFocus.current?.isConnected) lastFocus.current.focus({ preventScroll: true })
  }, [biz])
  const expand = (): void => {
    lastFocus.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
    biz.setExpanded(true)
  }
  const setDock = (): void =>
    setPreferences((value) => ({ ...value, dock: right ? 'bottom' : 'right' }))
  const toggleMaximized = (): void => setMaximized((value) => !value)
  const saveSize = (): void => {
    if (mobile || !expanded || maximized) return
    const size = terminalPanel.current?.getSize().inPixels
    if (size !== undefined)
      setPreferences((value) => ({ ...value, [right ? 'width' : 'height']: size }))
  }
  return {
    root,
    terminalPanel,
    preferences,
    right,
    maximized,
    pageVisible,
    setDock,
    toggleMaximized,
    saveSize,
    collapse,
    expand
  }
}
