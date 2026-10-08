import type { Metadata } from 'next'
import type { ReactElement } from 'react'
import { Changelog } from '@client/l1_entry/l1-pages'
import { getChangelog, siteRelease } from '@server/l1_entry/l1-content'

export const metadata: Metadata = {
  title: '更新日志',
  ...(siteRelease.siteUrl ? { alternates: { canonical: '/changelog/' } } : {})
}

export default async function Page(): Promise<ReactElement> {
  return <Changelog entries={await getChangelog()} />
}
