import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import type { ReactElement } from 'react'
import { Docs } from '@client/l1_entry/l1-pages'
import { documents, type DocumentPath } from '@common/l2_biz/docs/l2-docs'
import { getDocumentContent, siteRelease } from '@server/l1_entry/l1-content'

export const dynamicParams = false

const paths = (Object.keys(documents) as DocumentPath[]).filter(
  (path) => !['/docs/', '/docs/devices/', '/docs/faq/'].includes(path)
)

export function generateStaticParams(): { slug: string }[] {
  return paths.map((path) => ({ slug: path.slice(6, -1) }))
}

function getPath(slug: string): DocumentPath {
  const path = paths.find((path) => path === `/docs/${slug}/`)
  if (!path) notFound()
  return path
}

export async function generateMetadata({
  params
}: {
  params: Promise<{ slug: string }>
}): Promise<Metadata> {
  const path = getPath((await params).slug)
  const { title, description } = documents[path]
  return {
    title,
    description,
    ...(siteRelease.siteUrl ? { alternates: { canonical: path } } : {})
  }
}

export default async function Page({
  params
}: {
  params: Promise<{ slug: string }>
}): Promise<ReactElement> {
  const path = getPath((await params).slug)
  return <Docs path={path} content={await getDocumentContent(path, siteRelease)} />
}
