'use client'

import { useEffect } from 'react'

export default function GlobalError({
  error,
  reset
}: {
  error: Error & { digest?: string }
  reset: () => void
}): React.JSX.Element {
  useEffect(() => {
    console.error('[Pi Desk][Root] 页面初始化失败', error)
  }, [error])
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          padding: '15vh 1rem',
          fontFamily: 'system-ui, sans-serif',
          textAlign: 'center'
        }}
      >
        <h1>Page unavailable / 页面暂时无法加载</h1>
        <button type="button" onClick={reset} style={{ padding: '0.5rem 1rem', cursor: 'pointer' }}>
          Try again / 重试
        </button>
      </body>
    </html>
  )
}
