import type { MetadataRoute } from 'next'
import { documents } from '@common/l2_biz/docs/l2-docs'
import { siteRelease } from '@server/l1_entry/l1-content'

export const dynamic = 'force-static'

export default function sitemap(): MetadataRoute.Sitemap {
  if (!siteRelease.siteUrl) return []
  return ['/', ...Object.keys(documents), '/changelog/'].map((pathname) => ({
    url: new URL(pathname, siteRelease.siteUrl!).href
  }))
}
