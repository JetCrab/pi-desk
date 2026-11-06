'use client'

import { useEffect, useRef, type ReactElement, type ReactNode } from 'react'

export function MarkdownCodeBlocks({
  children,
  className
}: {
  children: ReactNode
  className?: string
}): ReactElement {
  const container = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let disposed = false
    const cleanups: (() => void)[] = []
    container.current?.querySelectorAll<HTMLButtonElement>('[data-code-copy]').forEach((button) => {
      const block = button.closest('.markdown-code-block')!
      const code = block.querySelector('code')!
      const status = block.querySelector<HTMLElement>('[role="status"]')!
      let timer: ReturnType<typeof setTimeout> | undefined
      button.hidden = false

      async function copy(): Promise<void> {
        clearTimeout(timer)
        button.disabled = true
        status.textContent = ''
        status.classList.remove('is-error')
        try {
          // 只读取代码文本，保留缩进和换行，不复制高亮标记。
          await navigator.clipboard.writeText(code.textContent ?? '')
          if (disposed) return
          button.textContent = '已复制'
          status.textContent = '代码已复制'
          timer = setTimeout(() => {
            button.textContent = '复制'
            status.textContent = ''
          }, 2000)
        } catch (error) {
          console.warn('官网代码复制失败', error)
          if (disposed) return
          button.textContent = '重试复制'
          status.textContent = '复制失败，请选择代码后手动复制。'
          status.classList.add('is-error')
        } finally {
          if (!disposed) button.disabled = false
        }
      }

      function onClick(): void {
        void copy()
      }
      button.addEventListener('click', onClick)
      cleanups.push(() => {
        clearTimeout(timer)
        button.removeEventListener('click', onClick)
        button.hidden = true
        button.disabled = false
        button.textContent = '复制'
        status.textContent = ''
        status.classList.remove('is-error')
      })
    })
    return () => {
      disposed = true
      cleanups.forEach((cleanup) => cleanup())
    }
  }, [children])

  return (
    <div ref={container} className={className}>
      {children}
    </div>
  )
}
