import type { ReactElement, ReactNode } from 'react'
import { DocsLayout } from '@client/l1_entry/l1-pages'

export default function Layout({ children }: { children: ReactNode }): ReactElement {
  return <DocsLayout>{children}</DocsLayout>
}
