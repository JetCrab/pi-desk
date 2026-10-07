'use client'

import {
  BotIcon,
  DatabaseIcon,
  FileIcon,
  FolderIcon,
  GlobeIcon,
  MessageSquareIcon,
  PanelTopIcon,
  PlugIcon,
  RocketIcon,
  ServerIcon,
  SettingsIcon,
  TerminalIcon,
  WrenchIcon,
  type LucideIcon
} from 'lucide-react'
import type { BrowserBuiltinIconName, BrowserContributionIcon } from '@jetcrab/pi-desk-sdk/browser'
import { cn } from '@client/l4_foundation/lib/l4-utils'

const BUILTIN_ICONS: Record<BrowserBuiltinIconName, LucideIcon> = {
  plugin: PlugIcon,
  server: ServerIcon,
  rocket: RocketIcon,
  settings: SettingsIcon,
  panel: PanelTopIcon,
  message: MessageSquareIcon,
  terminal: TerminalIcon,
  file: FileIcon,
  folder: FolderIcon,
  bot: BotIcon,
  wrench: WrenchIcon,
  database: DatabaseIcon,
  globe: GlobeIcon
}

const sanitizedSvgCache = new Map<string, string | null>()

function sanitizeSvg(content: string): string | null {
  if (sanitizedSvgCache.has(content)) return sanitizedSvgCache.get(content) ?? null
  const normalized = content.trim()
  const invalid =
    normalized.length > 16 * 1024 ||
    !/^<svg[\s>]/i.test(normalized) ||
    !/<\/svg>$/i.test(normalized) ||
    /<\s*(script|foreignObject|iframe|object|embed|link|style)\b/i.test(normalized) ||
    /\son[a-z]+\s*=/i.test(normalized) ||
    /(javascript:|data:text\/html|https?:\/\/)/i.test(normalized)
  const result = invalid ? null : normalized
  sanitizedSvgCache.set(content, result)
  return result
}

export function L4PluginIcon({
  icon,
  className
}: {
  icon?: BrowserContributionIcon
  className?: string
}): React.JSX.Element {
  if (icon?.type === 'svg') {
    const svg = sanitizeSvg(icon.content)
    if (svg) {
      return (
        <span
          aria-hidden="true"
          className={cn('block [&>svg]:size-full', className)}
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      )
    }
  }

  const Icon = icon?.type === 'builtin' ? BUILTIN_ICONS[icon.name] : PlugIcon
  return <Icon aria-hidden="true" className={className} />
}
