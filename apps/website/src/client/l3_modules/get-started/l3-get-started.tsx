import { Tabs } from '@base-ui/react/tabs'
import { ArrowDownToLine, Monitor, QrCode, Smartphone } from 'lucide-react'
import Image from 'next/image'
import Link from 'next/link'
import type { ReactElement } from 'react'
import { Button, buttonVariants } from '@client/l4_foundation/ui/shadcn/button'
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger
} from '@client/l4_foundation/ui/shadcn/popover'
import {
  nodeRequirement,
  startCommand,
  type SiteRelease
} from '@common/l3_modules/site/l3-site-release'
import { Command } from '@client/l4_foundation/ui/l4-command'
import { CliInstall } from './l3-cli-install'

export function GetStarted({
  release,
  androidQrCode
}: {
  release: SiteRelease
  androidQrCode: string | null
}): ReactElement {
  return (
    <Tabs.Root
      defaultValue="download"
      className="w-full max-w-[480px] min-w-0"
      aria-label="安装与下载"
    >
      <Tabs.List activateOnFocus className="mb-4 flex justify-center gap-2" aria-label="安装方式">
        <Tabs.Tab
          value="cli"
          className="min-h-8 rounded-lg px-3 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground data-active:bg-accent data-active:font-medium data-active:text-foreground"
        >
          命令行安装
        </Tabs.Tab>
        <Tabs.Tab
          value="download"
          className="min-h-8 rounded-lg px-3 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground data-active:bg-accent data-active:font-medium data-active:text-foreground"
        >
          下载
        </Tabs.Tab>
      </Tabs.List>
      <div className="min-h-[108px]">
        <Tabs.Panel value="download" className="mx-auto max-w-[400px] text-left">
          <ul className="divide-y divide-border">
            <li className="flex min-h-14 flex-wrap items-center gap-x-3 gap-y-2 py-3">
              <span className="flex flex-1 items-center gap-3 font-medium">
                <Monitor size={18} className="shrink-0 text-muted-foreground" aria-hidden="true" />
                Windows
              </span>
              {release.desktop ? (
                <a
                  href={release.desktop.url}
                  aria-label="下载 Windows 版"
                  className={buttonVariants({ variant: 'secondary', className: 'shrink-0' })}
                >
                  <ArrowDownToLine size={16} aria-hidden="true" />
                  下载
                </a>
              ) : (
                <span className="text-xs text-muted-foreground">筹备中</span>
              )}
            </li>
            <li className="flex min-h-14 flex-wrap items-center gap-x-3 gap-y-2 py-3">
              <span className="flex flex-1 items-center gap-3 font-medium">
                <Smartphone
                  size={18}
                  className="shrink-0 text-muted-foreground"
                  aria-hidden="true"
                />
                Android
              </span>
              {release.androidUrl ? (
                <div className="ml-auto flex items-center gap-2">
                  {androidQrCode && (
                    <Popover>
                      <PopoverTrigger
                        render={<Button variant="ghost" aria-label="手机扫码下载 Android" />}
                      >
                        <QrCode size={16} aria-hidden="true" />
                        扫码
                      </PopoverTrigger>
                      <PopoverContent className="w-auto items-center gap-2">
                        <PopoverTitle>手机扫码</PopoverTitle>
                        <Image
                          src={androidQrCode}
                          alt="扫码下载 Android APK"
                          width={160}
                          height={160}
                          unoptimized
                          className="bg-white"
                        />
                      </PopoverContent>
                    </Popover>
                  )}
                  <a
                    href={release.androidUrl}
                    aria-label="下载 Android APK"
                    className={buttonVariants({ variant: 'secondary', className: 'shrink-0' })}
                  >
                    <ArrowDownToLine size={16} aria-hidden="true" />
                    下载
                  </a>
                </div>
              ) : (
                <span className="text-xs text-muted-foreground">筹备中</span>
              )}
            </li>
          </ul>
          <ul className="mt-2 flex flex-wrap items-center gap-x-6 gap-y-2 border-t border-border pt-4 text-sm text-muted-foreground">
            <li className="flex items-center gap-2">
              <span>macOS</span>
              <span className="text-xs">筹备中</span>
            </li>
            <li className="flex items-center gap-2">
              <span>iOS</span>
              <span className="text-xs">筹备中</span>
            </li>
            <li>
              <Link
                href="/docs/docker/"
                className="inline-flex min-h-8 items-center underline underline-offset-4 hover:text-foreground"
              >
                Docker 部署指南
              </Link>
            </li>
          </ul>
        </Tabs.Panel>
        <Tabs.Panel value="cli" className="space-y-5 text-left">
          {release.installCommand ? (
            <CliInstall command={release.installCommand} />
          ) : (
            <p className="flex min-h-9 items-center rounded-lg bg-muted px-3 text-muted-foreground">
              公开安装包准备中
            </p>
          )}
          <Command label="启动" command={startCommand} />
          <p className="text-center text-xs text-muted-foreground">{nodeRequirement}</p>
        </Tabs.Panel>
      </div>
    </Tabs.Root>
  )
}
