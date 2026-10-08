import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import { SiteHeader } from '@client/l1_entry/l1-site-header'
import { siteRelease } from '@server/l1_entry/l1-content'
import '@client/l4_foundation/styles/l4-site.css'

export const dynamic = 'error'

export const metadata: Metadata = {
  title: { default: 'Pi Desk — 简单，而不简单', template: '%s · Pi Desk' },
  description: '在电脑和手机上使用 Pi Desk，通过对话处理项目、查看文件与结果、跟进任务进展。',
  ...(siteRelease.siteUrl
    ? { metadataBase: new URL(siteRelease.siteUrl) }
    : { robots: { index: false, follow: false } })
}

export default function RootLayout({ children }: { children: ReactNode }): ReactNode {
  return (
    <html
      lang="zh-CN"
      data-theme="light"
      data-scroll-behavior="smooth"
      suppressHydrationWarning
      className="scroll-smooth [scrollbar-width:thin] motion-reduce:scroll-auto has-[.home-page]:snap-y has-[.home-page]:snap-mandatory"
    >
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html:
              "try{document.documentElement.dataset.theme=localStorage.getItem('pi-super-website-theme')==='dark'?'dark':'light'}catch{}"
          }}
        />
      </head>
      <body className="m-0 bg-background font-sans text-sm leading-normal text-foreground antialiased [&_a]:touch-manipulation [&_a:focus-visible]:rounded-sm [&_a:focus-visible]:outline-2 [&_a:focus-visible]:outline-offset-4 [&_a:focus-visible]:outline-ring [&_button:not(:disabled)]:cursor-pointer [&_button]:touch-manipulation [&_button:focus-visible]:outline-2 [&_button:focus-visible]:outline-offset-2 [&_button:focus-visible]:outline-ring">
        <a
          className="fixed -top-20 left-4 z-50 rounded-md bg-primary px-3 py-2 text-primary-foreground focus:top-3"
          href="#main"
        >
          跳到主要内容
        </a>
        <SiteHeader sourceUrl={siteRelease.sourceUrl} />
        {children}
      </body>
    </html>
  )
}
