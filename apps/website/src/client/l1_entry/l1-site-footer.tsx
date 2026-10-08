import type { ReactElement } from 'react'
import type { SiteRelease } from '@common/l3_modules/site/l3-site-release'
import { siteAuthorEmail, siteAuthorGithubUrl, siteAuthorName } from './l1-site-author'
import { SiteAvatar } from './l1-site-avatar'

export function SiteFooter({ release }: { release: SiteRelease }): ReactElement {
  return (
    <footer
      className="flex min-h-[360px] snap-end bg-background md:min-h-[48svh]"
      aria-label="项目信息"
    >
      <div className="mx-auto grid w-full max-w-6xl grid-cols-[1fr_auto_1fr] items-end gap-6 px-6 py-10 text-xs text-muted-foreground max-sm:grid-cols-2 max-sm:grid-rows-[1fr_auto] max-sm:gap-x-4 max-sm:px-5 max-sm:py-8">
        <a
          href={siteAuthorGithubUrl}
          target="_blank"
          rel="noreferrer"
          aria-label={`${siteAuthorName} 的 GitHub 主页`}
          className="col-start-2 row-start-1 flex flex-col items-center gap-3 self-center justify-self-center text-foreground transition-opacity hover:opacity-80 max-sm:col-span-2 max-sm:col-start-1"
        >
          <SiteAvatar />
          <span className="text-xl font-medium tracking-tight">{siteAuthorName}</span>
        </a>
        {release.license && (
          <a
            href={release.license.url}
            target="_blank"
            rel="noreferrer"
            className="col-start-1 row-start-1 inline-flex min-h-8 items-center justify-self-start underline decoration-border underline-offset-4 hover:text-foreground max-sm:row-start-2"
          >
            {release.license.name}
          </a>
        )}
        <a
          href={`mailto:${siteAuthorEmail}`}
          className="col-start-3 row-start-1 inline-flex min-h-8 items-center justify-self-end whitespace-nowrap underline decoration-border underline-offset-4 hover:text-foreground max-sm:col-start-2 max-sm:row-start-2"
        >
          {siteAuthorEmail}
        </a>
      </div>
    </footer>
  )
}
