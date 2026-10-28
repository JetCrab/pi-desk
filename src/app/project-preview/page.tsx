import { Suspense } from 'react'
import type { Metadata } from 'next'
import { L1ProjectPreviewPage } from '@client/l1_entry/pages/l1-project-preview-page'
import { buildL2ProjectPreviewTitle } from '@common/l2_biz/project-preview/l2-project-preview-navigation'

export async function generateMetadata({
  searchParams
}: {
  searchParams: Promise<{ cwd?: string | string[] }>
}): Promise<Metadata> {
  const { cwd } = await searchParams
  return { title: buildL2ProjectPreviewTitle(Array.isArray(cwd) ? cwd[0] : cwd) }
}

export default function ProjectPreview(): React.JSX.Element {
  return (
    <Suspense>
      <L1ProjectPreviewPage />
    </Suspense>
  )
}
