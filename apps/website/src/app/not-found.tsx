import Link from 'next/link'
import type { ReactElement } from 'react'

export default function NotFound(): ReactElement {
  return (
    <main id="main" className="mx-auto min-h-[calc(100svh-144px)] max-w-4xl px-6 py-20 max-md:px-4">
      <p className="text-sm text-muted-foreground">404</p>
      <h1 className="mt-3 text-2xl font-semibold">这个页面没有找到。</h1>
      <p className="mt-4 text-muted-foreground">可以返回首页，继续浏览产品演示与使用指南。</p>
      <Link className="mt-6 inline-block underline underline-offset-4" href="/">
        返回首页
      </Link>
    </main>
  )
}
