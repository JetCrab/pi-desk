'use client'

import { EllipsisIcon } from 'lucide-react'
import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { BrowserSessionHeaderItemTarget, PluginSource } from '@jetcrab/pi-desk-sdk/browser'
import { useL4PluginRegistry } from '@client/l4_foundation/plugin-host/l4-plugin-host-context'
import { L4PluginIcon } from '@client/l4_foundation/plugin-host/l4-plugin-icon'
import type { L4PluginBrowserContributionDescriptor } from '@client/l4_foundation/plugin-host/l4-plugin-host-runtime'
import { Button, buttonVariants } from '@client/l4_foundation/ui/shadcn/button'
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger
} from '@client/l4_foundation/ui/shadcn/popover'
import { L2PluginContributionHost } from './l2-plugin-contribution-host'
import { calculateL2PluginSessionHeaderInlineCount } from './l2-plugin-session-header-layout'
import { L2PluginSessionHeaderAction } from './views/l2-plugin-session-header-action'

interface HeaderItem {
  pluginName: string
  descriptor: Extract<L4PluginBrowserContributionDescriptor, { kind: 'session-header-item' }>
}

interface L2PluginSessionHeaderProps {
  source: PluginSource
  title: ReactNode
}

function itemKey(item: HeaderItem): string {
  return `${item.pluginName}:${item.descriptor.contributionName}`
}

function HeaderItemView({
  item,
  source,
  presentation,
  onSelected
}: {
  item: HeaderItem
  source: PluginSource
  presentation: 'inline' | 'overflow'
  onSelected?: () => void
}): React.JSX.Element {
  const definition = item.descriptor[presentation]
  const target = useMemo<BrowserSessionHeaderItemTarget>(
    () => ({ kind: 'session-header-item', source, presentation }),
    [presentation, source]
  )
  const sourceKey = JSON.stringify([source.workId, source.sessionId, source.branchId, presentation])
  if (definition.type === 'action') {
    return (
      <L2PluginSessionHeaderAction
        pluginName={item.pluginName}
        contributionName={item.descriptor.contributionName}
        presentation={presentation}
        source={source}
        icon={definition.icon}
        label={definition.label}
        onSelected={onSelected}
      />
    )
  }
  return (
    <div
      data-testid="plugin-session-header-custom"
      data-plugin-name={item.pluginName}
      data-contribution-name={item.descriptor.contributionName}
      data-presentation={presentation}
      className="min-w-0 shrink-0"
      style={
        presentation === 'inline' && item.descriptor.inline.type === 'custom'
          ? { width: `${item.descriptor.inline.minWidthRem}rem` }
          : undefined
      }
    >
      <L2PluginContributionHost
        pluginName={item.pluginName}
        kind="session-header-item"
        contributionName={item.descriptor.contributionName}
        target={target}
        targetKey={sourceKey}
        layout="inline"
      />
    </div>
  )
}

export function L2PluginSessionHeader({
  source,
  title
}: L2PluginSessionHeaderProps): React.JSX.Element {
  const { t } = useTranslation('workbench')
  const registry = useL4PluginRegistry()
  const items = useMemo<HeaderItem[]>(
    () =>
      registry.flatMap((entry) =>
        entry.contributions.flatMap((descriptor) =>
          descriptor.kind === 'session-header-item'
            ? [{ pluginName: entry.pluginName, descriptor }]
            : []
        )
      ),
    [registry]
  )
  const rootRef = useRef<HTMLDivElement>(null)
  const measurementsRef = useRef<HTMLDivElement>(null)
  const [measurement, setMeasurement] = useState<{
    items: readonly HeaderItem[]
    count: number
  } | null>(null)
  const [open, setOpen] = useState(false)
  const count = measurement?.items === items ? measurement.count : 0
  const inlineItems = items.slice(0, count)
  const overflowItems = items.slice(count)

  useLayoutEffect(() => {
    const root = rootRef.current
    const measurements = measurementsRef.current
    if (!root || !measurements || items.length === 0) return
    const probes = [...measurements.querySelectorAll<HTMLElement>('[data-header-item-width]')]
    const titleProbe = measurements.querySelector<HTMLElement>('[data-header-title-width]')!
    const moreProbe = measurements.querySelector<HTMLElement>('[data-header-more-width]')!
    const gapProbe = measurements.querySelector<HTMLElement>('[data-header-gap-width]')!
    const measure = (): void => {
      const gap = gapProbe.getBoundingClientRect().width
      const available =
        root.getBoundingClientRect().width - titleProbe.getBoundingClientRect().width - gap
      const nextCount = calculateL2PluginSessionHeaderInlineCount(
        probes.map((probe) => probe.getBoundingClientRect().width),
        available,
        moreProbe.getBoundingClientRect().width,
        gap
      )
      if (nextCount === items.length) setOpen(false)
      setMeasurement((current) =>
        current?.items === items && current.count === nextCount
          ? current
          : { items, count: nextCount }
      )
    }
    const observer = new ResizeObserver(measure)
    observer.observe(root)
    for (const probe of [...probes, titleProbe, moreProbe, gapProbe]) observer.observe(probe)
    measure()
    return () => observer.disconnect()
  }, [items])

  return (
    <div
      ref={rootRef}
      className="relative flex min-w-0 flex-1 items-center gap-1"
      data-testid="plugin-session-header"
    >
      <div className="min-w-[3rem] flex-1">{title}</div>
      {items.length > 0 ? (
        <>
          <div className="flex shrink-0 items-center gap-1" data-testid="session-header-items">
            {inlineItems.map((item) => (
              <HeaderItemView
                key={itemKey(item)}
                item={item}
                source={source}
                presentation="inline"
              />
            ))}
            {overflowItems.length > 0 ? (
              <Popover open={open} onOpenChange={setOpen}>
                <PopoverTrigger
                  render={
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t('moreActions')}
                      data-testid="session-header-more"
                    />
                  }
                >
                  <EllipsisIcon className="size-4" />
                </PopoverTrigger>
                <PopoverContent
                  align="end"
                  finalFocus
                  className="pi-desk-chat-scrollbar max-h-[min(28rem,var(--available-height))] gap-1 overflow-auto p-1"
                  data-testid="session-header-overflow"
                  aria-label={t('moreActions')}
                >
                  <PopoverTitle className="sr-only">{t('moreActions')}</PopoverTitle>
                  {open
                    ? overflowItems.map((item) => (
                        <HeaderItemView
                          key={itemKey(item)}
                          item={item}
                          source={source}
                          presentation="overflow"
                          onSelected={() => setOpen(false)}
                        />
                      ))
                    : null}
                </PopoverContent>
              </Popover>
            ) : null}
          </div>
          {/* 只测量可克隆元数据；custom 业务视图仅在当前展示位置挂载。 */}
          <div
            ref={measurementsRef}
            aria-hidden="true"
            inert
            className="pointer-events-none invisible absolute inset-0 overflow-hidden"
          >
            <div className="flex w-max items-center">
              <span data-header-title-width className="inline-block w-[3rem]" />
              <span data-header-gap-width className="inline-block w-1" />
              <span
                data-header-more-width
                className={buttonVariants({ variant: 'ghost', size: 'icon-sm' })}
              >
                <EllipsisIcon className="size-4" />
              </span>
              {items.map((item) =>
                item.descriptor.inline.type === 'action' ? (
                  <span
                    key={itemKey(item)}
                    data-header-item-width
                    className={buttonVariants({ variant: 'ghost', size: 'sm' })}
                  >
                    <L4PluginIcon icon={item.descriptor.inline.icon} className="size-4" />
                    <span>{item.descriptor.inline.label}</span>
                  </span>
                ) : (
                  <span
                    key={itemKey(item)}
                    data-header-item-width
                    className="inline-block shrink-0"
                    style={{ width: `${item.descriptor.inline.minWidthRem}rem` }}
                  />
                )
              )}
            </div>
          </div>
        </>
      ) : null}
    </div>
  )
}
