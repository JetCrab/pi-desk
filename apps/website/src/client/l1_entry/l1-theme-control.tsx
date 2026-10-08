'use client'

import { Moon, Sun } from 'lucide-react'
import { useRef, useSyncExternalStore, type MouseEvent, type ReactElement } from 'react'
import { flushSync } from 'react-dom'
import { Button } from '@client/l4_foundation/ui/shadcn/button'
import styles from './l1-theme-control.module.css'

type Theme = 'light' | 'dark'
const key = 'pi-super-website-theme'
const event = 'website-theme-change'

function readTheme(): Theme {
  const value = document.documentElement.dataset.theme
  return value === 'dark' ? 'dark' : 'light'
}

function subscribe(listener: () => void): () => void {
  function applyStoredTheme(value: string | null): void {
    document.documentElement.dataset.theme = value === 'dark' ? 'dark' : 'light'
    listener()
  }

  function syncStorage(change: StorageEvent): void {
    if (change.key !== key && change.key !== null) return
    applyStoredTheme(change.newValue)
  }

  window.addEventListener(event, listener)
  window.addEventListener('storage', syncStorage)
  try {
    // 首屏脚本与 React 订阅之间，其他标签页可能已经更新偏好。
    applyStoredTheme(localStorage.getItem(key))
  } catch (error) {
    console.warn('官网主题偏好无法读取', error)
  }
  return () => {
    window.removeEventListener(event, listener)
    window.removeEventListener('storage', syncStorage)
  }
}

function toggleTheme(): void {
  const next = readTheme() === 'light' ? 'dark' : 'light'
  document.documentElement.dataset.theme = next
  try {
    localStorage.setItem(key, next)
  } catch (error) {
    console.warn('官网主题偏好无法保存', error)
  }
  window.dispatchEvent(new Event(event))
}

export function ThemeControl(): ReactElement {
  const activeTransition = useRef<ViewTransition | null>(null)
  const theme = useSyncExternalStore(subscribe, readTheme, () => 'light' as const)
  const next = theme === 'light' ? 'dark' : 'light'
  const label = next === 'dark' ? '切换到深色' : '切换到浅色'
  const Icon = next === 'dark' ? Moon : Sun

  async function changeTheme(click: MouseEvent<HTMLButtonElement>): Promise<void> {
    activeTransition.current?.skipTransition()
    if (
      !document.startViewTransition ||
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    ) {
      toggleTheme()
      return
    }

    const root = document.documentElement
    const button = click.currentTarget
    const rect = button.getBoundingClientRect()
    const x = rect.left + rect.width / 2
    const y = rect.top + rect.height / 2
    const radius = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y))
    root.classList.add(styles.transition)
    // 在新画面捕获前同步按钮图标，避免主题与图标分两次更新。
    const transition = document.startViewTransition(() => flushSync(toggleTheme))
    activeTransition.current = transition
    // 整页快照期间浏览器只命中根节点，接回按钮原区域内的点击。
    function repeatClick(event: globalThis.MouseEvent): void {
      if (
        activeTransition.current === transition &&
        event.target === root &&
        event.clientX >= rect.left &&
        event.clientX <= rect.right &&
        event.clientY >= rect.top &&
        event.clientY <= rect.bottom
      ) {
        button.click()
      }
    }
    root.addEventListener('click', repeatClick)
    try {
      await transition.ready
      root.animate(
        { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`] },
        { duration: 400, easing: 'ease-out', pseudoElement: '::view-transition-new(root)' }
      )
    } catch (error) {
      if (
        activeTransition.current === transition &&
        !(error instanceof DOMException && error.name === 'AbortError')
      ) {
        console.warn('官网主题动画未完成，已直接切换主题', error)
      }
      transition.skipTransition()
    } finally {
      await transition.finished
      root.removeEventListener('click', repeatClick)
      if (activeTransition.current === transition) {
        activeTransition.current = null
        root.classList.remove(styles.transition)
      }
    }
  }

  return (
    <Button variant="ghost" size="icon" aria-label={label} title={label} onClick={changeTheme}>
      <Icon aria-hidden="true" />
    </Button>
  )
}
