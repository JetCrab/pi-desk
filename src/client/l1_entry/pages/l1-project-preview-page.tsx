'use client'

import { useCallback, useEffect, useRef } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { L2BuildLoginHref } from '@common/l2_biz/auth/l2-auth-return-to'
import { buildL2ProjectPreviewHref } from '@common/l2_biz/project-preview/l2-project-preview-navigation'
import { useL4ClientId } from '@client/l4_foundation/lib/l4-client-id'
import { L2ProjectPreviewPage } from '@client/l2_biz/project-preview/l2-project-preview-page'

export function L1ProjectPreviewPage(): React.JSX.Element {
  const clientId = useL4ClientId()
  const params = useSearchParams()
  const router = useRouter()
  const cwd = params.get('cwd')?.trim() || null
  const redirecting = useRef(false)
  const onUnauthorized = useCallback((): void => {
    if (redirecting.current) return
    redirecting.current = true
    window.location.assign(L2BuildLoginHref(window.location.pathname + window.location.search))
  }, [])
  useEffect(() => {
    const name = cwd?.replaceAll('\\', '/').split('/').filter(Boolean).at(-1)
    document.title = name ? `${name} · Pi Desk` : 'Pi Desk'
  }, [cwd])
  return (
    <L2ProjectPreviewPage
      clientId={clientId}
      cwd={cwd}
      onUnauthorized={onUnauthorized}
      onSelect={(directory) => router.push(buildL2ProjectPreviewHref(directory))}
    />
  )
}
