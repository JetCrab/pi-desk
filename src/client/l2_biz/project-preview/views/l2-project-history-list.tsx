'use client'
import { useLayoutEffect, useRef, useState, type ReactNode, type KeyboardEventHandler } from 'react'

export function L2ProjectHistoryList<T>({
  items,
  label,
  scrollTop,
  onScroll,
  render,
  role = 'listbox',
  onKeyDown
}: {
  items: readonly T[]
  label: string
  scrollTop: number
  onScroll: (value: number) => void
  render: (item: T, index: number) => ReactNode
  role?: 'listbox' | 'tree'
  onKeyDown?: KeyboardEventHandler<HTMLDivElement>
}): React.JSX.Element {
  const viewport = useRef<HTMLDivElement>(null)
  const [window, setWindow] = useState({ top: scrollTop, height: 300 })
  useLayoutEffect(() => {
    const element = viewport.current
    if (!element) return
    element.scrollTop = scrollTop
    const measure = (): void => setWindow({ top: element.scrollTop, height: element.clientHeight })
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
    // 切换查询由父级 key 重建；同一查询翻页不重置滚动。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useLayoutEffect(() => {
    if (viewport.current) viewport.current.scrollTop = scrollTop
  }, [items, scrollTop])
  const start = Math.max(0, Math.floor(window.top / 36) - 8)
  const end = Math.min(items.length, Math.ceil((window.top + window.height) / 36) + 8)
  return (
    <div
      ref={viewport}
      role={role}
      tabIndex={role === 'tree' ? 0 : undefined}
      onKeyDown={onKeyDown}
      aria-label={label}
      className="min-h-0 flex-1 overflow-auto overscroll-contain"
      onScroll={(event) => {
        const top = event.currentTarget.scrollTop
        setWindow((previous) => ({ ...previous, top }))
        onScroll(top)
      }}
    >
      <div style={{ height: items.length * 36, position: 'relative' }}>
        <div style={{ position: 'absolute', top: start * 36, left: 0, right: 0 }}>
          {items.slice(start, end).map((item, index) => render(item, start + index))}
        </div>
      </div>
    </div>
  )
}
