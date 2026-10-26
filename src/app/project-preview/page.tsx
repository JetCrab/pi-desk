import { Suspense } from 'react'
import { L1ProjectPreviewPage } from '@client/l1_entry/pages/l1-project-preview-page'

export default function ProjectPreview(): React.JSX.Element {
  return (
    <Suspense>
      <L1ProjectPreviewPage />
    </Suspense>
  )
}
