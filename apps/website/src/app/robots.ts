import type { MetadataRoute } from 'next'
import { siteRelease } from '@server/l1_entry/l1-content'

export const dynamic = 'force-static'

export default function robots(): MetadataRoute.Robots {
  return siteRelease.siteUrl
    ? {
        rules: { userAgent: '*', allow: '/' },
        sitemap: new URL('/sitemap.xml', siteRelease.siteUrl).href
      }
    : { rules: { userAgent: '*', disallow: '/' } }
}
