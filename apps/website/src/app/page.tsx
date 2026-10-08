import type { ReactElement } from 'react'
import type { Metadata } from 'next'
import { Home } from '@client/l1_entry/l1-pages'
import { SiteFooter } from '@client/l1_entry/l1-site-footer'
import { siteRelease } from '@server/l1_entry/l1-content'
import { createQrCodeDataUrl } from '@server/l4_foundation/l4-qr-code'

export const metadata: Metadata = {
  ...(siteRelease.siteUrl ? { alternates: { canonical: '/' } } : {})
}

export default async function Page(): Promise<ReactElement> {
  const androidQrCode = siteRelease.androidUrl
    ? await createQrCodeDataUrl(siteRelease.androidUrl)
    : null
  return (
    <>
      <Home release={siteRelease} androidQrCode={androidQrCode} />
      <SiteFooter release={siteRelease} />
    </>
  )
}
