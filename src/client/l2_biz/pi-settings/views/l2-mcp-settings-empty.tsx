import { GlobeIcon, PlusIcon, PlugIcon, TerminalIcon } from 'lucide-react'
import { Button } from '@client/l4_foundation/ui/shadcn/button'
import { useL2PiSettingsText } from '../l2-pi-settings-locale'

export function L2McpSettingsEmpty({
  pending,
  onAdd,
  onImport
}: {
  pending: boolean
  onAdd: () => void
  onImport: () => void
}): React.JSX.Element {
  const t = useL2PiSettingsText()

  return (
    <div className="pi-desk-chat-scrollbar min-h-0 min-w-0 flex-1 overflow-y-auto px-4 py-6">
      <div className="grid min-h-full grid-rows-[1fr_auto_2fr]">
        <div className="row-start-2 flex flex-col items-center gap-6 text-center">
          <div aria-hidden="true" className="relative h-28 w-60 shrink-0 text-muted-foreground">
            <svg
              viewBox="0 0 240 112"
              fill="none"
              className="absolute inset-0 size-full text-muted-foreground/40"
            >
              <path
                d="M44 76H64Q76 76 76 64V60Q76 56 92 56M148 56H164Q180 56 180 44Q180 40 196 40M120 12V28"
                stroke="currentColor"
              />
              <circle cx="120" cy="8" r="3" className="fill-background stroke-current" />
              <circle cx="64" cy="76" r="2" className="fill-muted-foreground" />
              <circle cx="180" cy="44" r="2" className="fill-muted-foreground" />
            </svg>
            <div className="absolute top-14 left-1 flex size-10 items-center justify-center rounded-xl border bg-muted/50">
              <TerminalIcon className="size-4" />
            </div>
            <div className="absolute top-7 left-[92px] flex size-14 items-center justify-center rounded-xl border bg-background text-foreground">
              <PlugIcon className="size-6" />
            </div>
            <div className="absolute top-5 right-1 flex size-10 items-center justify-center rounded-xl border bg-muted/50">
              <GlobeIcon className="size-4" />
            </div>
          </div>
          <h3 className="text-lg font-semibold">{t('添加第一个 MCP 服务')}</h3>
          <div className="flex flex-wrap justify-center gap-2">
            <Button disabled={pending} onClick={onAdd}>
              <PlusIcon aria-hidden="true" />
              {t('添加服务')}
            </Button>
            <Button variant="outline" disabled={pending} onClick={onImport}>
              {t('导入 JSON')}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
