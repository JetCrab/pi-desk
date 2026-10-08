'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Languages } from 'lucide-react'
import type { ReactElement } from 'react'
import { Button, buttonVariants } from '@client/l4_foundation/ui/shadcn/button'
import { L4BrandIcon } from '@client/l4_foundation/ui/l4-brand-icon'
import { siteAuthorGithubUrl } from './l1-site-author'
import { ThemeControl } from './l1-theme-control'

export function SiteHeader({ sourceUrl }: { sourceUrl: string | null }): ReactElement {
  const pathname = usePathname()
  return (
    <header className="snap-start bg-background">
      <div className="mx-auto grid min-h-[72px] max-w-6xl grid-cols-[1fr_auto_auto] items-center gap-6 px-6 py-4 max-sm:grid-cols-[1fr_auto] max-sm:gap-x-4 max-sm:gap-y-2 max-sm:px-5">
        <Link
          href="/"
          className="flex w-fit items-center gap-2 text-base font-semibold tracking-tight"
          aria-label="Pi Desk 首页"
        >
          <L4BrandIcon size={32} className="shrink-0" />
          Pi Desk
        </Link>
        <nav
          className="flex items-center gap-6 max-sm:order-3 max-sm:col-span-2 max-sm:justify-center"
          aria-label="主导航"
        >
          {/* 静态导出不强制完整运行时预取，阅读页沿用默认自动策略。 */}
          <Link
            className="flex min-h-8 items-center text-muted-foreground hover:text-foreground aria-[current=page]:text-foreground"
            href="/docs/"
            prefetch={pathname === '/' ? false : undefined}
            aria-current={pathname.startsWith('/docs') ? 'page' : undefined}
          >
            文档
          </Link>
          <Link
            className="flex min-h-8 items-center text-muted-foreground hover:text-foreground aria-[current=page]:text-foreground"
            href="/changelog/"
            prefetch={pathname === '/' ? false : undefined}
            aria-current={pathname.startsWith('/changelog') ? 'page' : undefined}
          >
            更新日志
          </Link>
        </nav>
        <div className="flex items-center justify-end gap-1">
          <a
            href={sourceUrl ?? siteAuthorGithubUrl}
            target="_blank"
            rel="noreferrer"
            aria-label="GitHub"
            title="GitHub"
            className={buttonVariants({ variant: 'ghost', size: 'icon' })}
          >
            {/* GitHub mark: Simple Icons (CC0). */}
            <svg viewBox="0 0 24 24" fill="currentColor" className="size-4" aria-hidden="true">
              <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
            </svg>
          </a>
          <Button
            variant="ghost"
            size="icon"
            disabled
            aria-label="切换语言（暂未开放）"
            title="语言（暂未开放）"
          >
            <Languages aria-hidden="true" />
          </Button>
          <ThemeControl />
        </div>
      </div>
    </header>
  )
}
