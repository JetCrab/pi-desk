'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { ChevronDown } from 'lucide-react'
import { useState, type ReactElement } from 'react'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger
} from '@client/l4_foundation/ui/shadcn/collapsible'
import { ScrollArea } from '@client/l4_foundation/ui/shadcn/scroll-area'
import { documentGroups, documents, type DocumentPath } from '@common/l2_biz/docs/l2-docs'

const paths = Object.keys(documents) as DocumentPath[]
const navigationScrollClassName =
  'min-h-0 overflow-hidden [&_[data-slot=scroll-area-scrollbar]]:h-full [&_[data-slot=scroll-area-scrollbar]]:w-2.5 [&_[data-slot=scroll-area-scrollbar]]:border-l [&_[data-slot=scroll-area-scrollbar]]:border-l-transparent'

function DocumentNavigation({
  path,
  onSelect
}: {
  path: string
  onSelect?: () => void
}): ReactElement {
  return (
    <nav aria-label="文档目录" className="space-y-5 pb-2">
      {documentGroups.map((group) => (
        <section key={group}>
          <h2 className="mb-2 flex cursor-default items-center gap-3 px-2 text-xs leading-5 font-medium text-muted-foreground">
            <span className="shrink-0">{group}</span>
            <span aria-hidden="true" className="h-px flex-1 bg-border" />
          </h2>
          <ul className="ml-2 grid gap-0.5">
            {paths
              .filter((href) => documents[href].group === group)
              .map((href) => (
                <li key={href}>
                  <Link
                    href={href}
                    aria-current={path === href ? 'page' : undefined}
                    onNavigate={(event) => {
                      if (path === href) event.preventDefault()
                      else onSelect?.()
                    }}
                    className="flex min-h-8 items-center rounded-md px-2 py-1 text-sm text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring aria-[current=page]:bg-accent aria-[current=page]:font-medium aria-[current=page]:text-foreground"
                  >
                    {documents[href].title}
                  </Link>
                </li>
              ))}
          </ul>
        </section>
      ))}
    </nav>
  )
}

export function DocsNavigation(): ReactElement {
  const pathname = usePathname()
  const path = pathname.endsWith('/') ? pathname : `${pathname}/`
  const [open, setOpen] = useState(false)
  return (
    <>
      <aside className="sticky top-6 flex h-[calc(100dvh-48px)] min-h-0 flex-col max-md:hidden">
        <Link
          href="/docs/"
          onNavigate={(event) => {
            if (path === '/docs/') event.preventDefault()
          }}
          className="mb-4 inline-flex min-h-8 shrink-0 items-center px-2 text-base font-semibold"
        >
          文档
        </Link>
        <ScrollArea className={`${navigationScrollClassName} flex-1`}>
          <div className="pr-3">
            <DocumentNavigation path={path} />
          </div>
        </ScrollArea>
      </aside>
      <div className="min-w-0 md:hidden">
        <Collapsible open={open} onOpenChange={setOpen}>
          <CollapsibleTrigger className="group flex min-h-8 w-full items-center justify-between border-b border-border pb-3 text-sm font-medium">
            文档目录
            <ChevronDown
              size={16}
              aria-hidden="true"
              className="transition-transform group-data-panel-open:rotate-180 motion-reduce:transition-none"
            />
          </CollapsibleTrigger>
          <CollapsibleContent keepMounted className="pt-4">
            <ScrollArea className={`${navigationScrollClassName} h-[min(60dvh,480px)]`}>
              <div className="pr-3">
                <DocumentNavigation path={path} onSelect={() => setOpen(false)} />
              </div>
            </ScrollArea>
          </CollapsibleContent>
        </Collapsible>
      </div>
    </>
  )
}
