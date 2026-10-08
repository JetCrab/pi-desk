import type { ReactElement } from 'react'
import type { SiteRelease } from '@common/l3_modules/site/l3-site-release'
import { GetStarted } from '@client/l3_modules/get-started/l3-get-started'
import { WorkbenchDemo } from './views/l2-workbench-demo'

export function Home({
  release,
  androidQrCode
}: {
  release: SiteRelease
  androidQrCode: string | null
}): ReactElement {
  return (
    <main id="main" className="home-page">
      <section
        id="install"
        aria-label="安装与下载"
        className="mx-auto grid min-h-[320px] max-w-6xl grid-cols-[minmax(0,1fr)_400px] items-center gap-12 px-6 py-10 md:min-h-[calc(48svh-72px)] max-md:grid-cols-1 max-md:justify-items-center max-md:gap-8 max-md:text-center max-sm:px-5"
      >
        <div>
          <h1 className="text-[clamp(38px,4.5vw,60px)] leading-[1.15] font-semibold tracking-tight">
            <span className="block font-medium text-muted-foreground">简单，</span>
            <span className="block">而不简单。</span>
          </h1>
          <p className="mt-5 text-base leading-relaxed text-muted-foreground">
            延续 Pi 的精简理念，让对话更顺手，让扩展更自由。
          </p>
        </div>
        <GetStarted release={release} androidQrCode={androidQrCode} />
      </section>
      <WorkbenchDemo />
    </main>
  )
}
