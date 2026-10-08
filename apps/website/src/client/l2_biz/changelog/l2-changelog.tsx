import type { ReactElement } from 'react'

export function Changelog({
  entries
}: {
  entries: { slug: string; date: number; html: string }[]
}): ReactElement {
  return (
    <main
      id="main"
      className="mx-auto min-h-[calc(100svh-144px)] max-w-4xl px-6 py-14 max-md:px-4 max-md:py-8"
    >
      <header className="mb-10">
        <h1 className="text-3xl font-semibold tracking-tight">更新日志</h1>
        <p className="mt-3 text-base text-muted-foreground">新功能、问题修复与升级说明。</p>
      </header>
      {entries.length ? (
        entries.map((entry) => (
          <article key={entry.slug} id={entry.slug} className="border-t border-border py-8">
            <time
              className="text-xs text-muted-foreground"
              dateTime={new Date(entry.date).toISOString()}
            >
              {new Intl.DateTimeFormat('zh-CN', {
                timeZone: 'Asia/Shanghai',
                year: 'numeric',
                month: 'long',
                day: 'numeric'
              }).format(entry.date)}
            </time>
            <div
              className="mt-5 text-base leading-relaxed wrap-anywhere [&_a]:underline [&_a]:underline-offset-4 [&_blockquote]:my-4 [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-4 [&_blockquote]:text-muted-foreground [&_code]:font-mono [&_code]:text-sm [&_h1]:mb-6 [&_h1]:text-2xl [&_h1]:font-semibold [&_h2]:mt-8 [&_h2]:mb-4 [&_h2]:text-xl [&_h2]:font-semibold [&_h3]:mt-6 [&_h3]:mb-3 [&_h3]:font-semibold [&_li]:my-2 [&_ol]:my-4 [&_ol]:list-decimal [&_ol]:pl-6 [&_p]:mb-4 [&_pre]:my-4 [&_pre]:overflow-auto [&_pre]:rounded-lg [&_pre]:border [&_pre]:border-border [&_pre]:bg-muted [&_pre]:p-4 [&_ul]:my-4 [&_ul]:list-disc [&_ul]:pl-6"
              dangerouslySetInnerHTML={{ __html: entry.html }}
            />
          </article>
        ))
      ) : (
        <section className="border-t border-border py-8">
          <h2 className="text-lg font-semibold">第一个公开版本，正在准备。</h2>
          <p className="mt-3 leading-7 text-muted-foreground">
            正式发布后，这里会记录每个版本的更新内容。
          </p>
        </section>
      )}
    </main>
  )
}
