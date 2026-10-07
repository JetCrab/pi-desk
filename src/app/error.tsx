'use client'

import { useEffect } from 'react'
import { L1ErrorPage } from '@client/l1_entry/pages/l1-error-page'

export default function ErrorPage({
  error,
  reset
}: {
  error: Error & { digest?: string }
  reset: () => void
}): React.JSX.Element {
  useEffect(() => {
    console.error('[Pi Desk][Page] 页面渲染失败', error)
  }, [error])
  return <L1ErrorPage retry={reset} />
}
