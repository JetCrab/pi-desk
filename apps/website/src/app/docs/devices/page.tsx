import type { Metadata } from 'next'
import type { ReactElement } from 'react'
import { Docs } from '@client/l1_entry/l1-pages'
import { documents } from '@common/l2_biz/docs/l2-docs'
import { getDocumentContent, siteRelease } from '@server/l1_entry/l1-content'

export const metadata: Metadata = {
  title: documents['/docs/devices/'].title,
  description: documents['/docs/devices/'].description,
  ...(siteRelease.siteUrl ? { alternates: { canonical: '/docs/devices/' } } : {})
}

export default async function Page(): Promise<ReactElement> {
  return <Docs path="/docs/devices/" content={await getDocumentContent('/docs/devices/')} />
}
