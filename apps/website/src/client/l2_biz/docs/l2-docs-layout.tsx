import type { ReactElement, ReactNode } from 'react'
import { DocsNavigation } from './l2-docs-navigation'

export function DocsLayout({ children }: { children: ReactNode }): ReactElement {
  return (
    <main
      id="main"
      className="mx-auto grid min-h-[calc(100svh-144px)] max-w-[1400px] items-start gap-10 px-6 py-10 md:grid-cols-[200px_minmax(0,1fr)] max-md:gap-6 max-md:px-4 max-md:py-6"
    >
      <DocsNavigation />
      {children}
    </main>
  )
}
