import Link from 'next/link'
import { ArrowLeft, ArrowRight, ChevronDown } from 'lucide-react'
import type { ReactElement } from 'react'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger
} from '@client/l4_foundation/ui/shadcn/collapsible'
import { documents, type DocumentContent, type DocumentPath } from '@common/l2_biz/docs/l2-docs'

const paths = Object.keys(documents) as DocumentPath[]

export function Docs({
  path,
  content
}: {
  path: DocumentPath
  content: DocumentContent
}): ReactElement {
  const document = documents[path]
  const index = paths.indexOf(path)
  const previous = paths[index - 1]
  const next = paths[index + 1]
  const hasTableOfContents = content.headings.length > 2
  return (
    <div
      className={`grid min-w-0 items-start gap-10 ${hasTableOfContents ? 'xl:grid-cols-[minmax(0,1fr)_168px]' : ''}`}
    >
      <article
        className={`mx-auto w-full min-w-0 ${path === '/docs/' ? 'max-w-4xl' : 'max-w-3xl'}`}
      >
        <header className="mb-8">
          <p className="mb-3 text-sm text-muted-foreground">{document.group}</p>
          <h1 className="text-[28px] leading-snug font-semibold tracking-tight">
            {document.title}
          </h1>
          <p className="mt-3 text-base leading-7 text-muted-foreground">{document.description}</p>
        </header>
        {hasTableOfContents ? (
          <Collapsible className="mb-8 border-y border-border py-2 xl:hidden">
            <CollapsibleTrigger className="group flex min-h-8 w-full items-center justify-between text-sm font-medium">
              本页内容
              <ChevronDown
                size={14}
                aria-hidden="true"
                className="transition-transform group-data-panel-open:rotate-180 motion-reduce:transition-none"
              />
            </CollapsibleTrigger>
            <CollapsibleContent>
              <ul className="grid gap-2 py-3 text-sm">
                {content.headings.map((heading) => (
                  <li key={heading.id}>
                    <a className="underline underline-offset-4" href={`#${heading.id}`}>
                      {heading.title}
                    </a>
                  </li>
                ))}
              </ul>
            </CollapsibleContent>
          </Collapsible>
        ) : null}
        <div
          className="text-base leading-[1.8] wrap-anywhere [&_a]:underline [&_a]:underline-offset-4 [&_a:hover]:text-muted-foreground [&_blockquote]:my-5 [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-4 [&_blockquote]:text-muted-foreground [&_code]:font-mono [&_code]:text-sm [&_h2]:mt-10 [&_h2]:mb-4 [&_h2]:scroll-mt-6 [&_h2]:text-xl [&_h2]:font-semibold [&_h3]:mt-7 [&_h3]:mb-3 [&_h3]:scroll-mt-6 [&_h3]:text-base [&_h3]:font-semibold [&_li]:my-2 [&_ol]:my-4 [&_ol]:list-decimal [&_ol]:pl-6 [&_p]:my-4 [&_pre]:my-5 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:border [&_pre]:border-border [&_pre]:bg-muted [&_pre]:p-4 [&_pre]:text-sm [&_pre]:leading-6 [&_pre]:[overflow-wrap:normal] [&_ul]:my-4 [&_ul]:list-disc [&_ul]:pl-6 [&_img]:my-5 [&_img]:h-auto [&_img]:max-w-full [&_img]:rounded-lg [&_.doc-table]:my-5 [&_.doc-table]:overflow-x-auto [&_table]:w-full [&_table]:border-collapse [&_table]:text-sm [&_th]:border-b [&_th]:border-border [&_th]:px-3 [&_th]:py-2 [&_th]:text-left [&_th]:font-semibold [&_td]:min-w-32 [&_td]:border-b [&_td]:border-border [&_td]:px-3 [&_td]:py-3 [&_td]:align-top [&_.doc-screenshot]:my-6 [&_.doc-screenshot]:block [&_.doc-screenshot]:cursor-zoom-in [&_.doc-screenshot]:rounded-lg [&_.doc-screenshot]:no-underline [&_.doc-screenshot:focus-visible]:outline-2 [&_.doc-screenshot:focus-visible]:outline-offset-4 [&_.doc-screenshot:focus-visible]:outline-ring [&_.doc-screenshot_img]:my-0 [&_.doc-screenshot_img]:border [&_.doc-screenshot_img]:border-border"
          dangerouslySetInnerHTML={{ __html: content.html }}
        />
        <nav
          aria-label="相邻文档"
          className="mt-12 flex items-start justify-between gap-6 border-t border-border pt-6 text-sm"
        >
          {previous ? (
            <Link href={previous} className="min-w-0 underline-offset-4 hover:underline">
              <span className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
                <ArrowLeft size={14} aria-hidden="true" />
                上一篇
              </span>
              {documents[previous].title}
            </Link>
          ) : (
            <span />
          )}
          {next ? (
            <Link href={next} className="min-w-0 text-right underline-offset-4 hover:underline">
              <span className="mb-2 flex items-center justify-end gap-2 text-xs text-muted-foreground">
                下一篇
                <ArrowRight size={14} aria-hidden="true" />
              </span>
              {documents[next].title}
            </Link>
          ) : null}
        </nav>
      </article>
      {hasTableOfContents ? (
        <nav
          aria-label="本页目录"
          className="sticky top-8 max-h-[calc(100svh-64px)] overflow-y-auto text-sm max-xl:hidden"
        >
          <p className="mb-3 font-medium">本页内容</p>
          <ul className="grid gap-3 border-l border-border pl-4">
            {content.headings.map((heading) => (
              <li key={heading.id}>
                <a
                  href={`#${heading.id}`}
                  className="text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                >
                  {heading.title}
                </a>
              </li>
            ))}
          </ul>
        </nav>
      ) : null}
    </div>
  )
}
