'use client'

import {
  BotIcon,
  CheckIcon,
  ChevronDownIcon,
  ImageIcon,
  RefreshCwIcon,
  Settings2Icon
} from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { L2ChatRuntime, L2ChatSource } from '@common/l2_biz/chat/l2-chat-contract'
import { PromptInputButton } from '@client/l4_foundation/ui/ai-elements/prompt-input'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger
} from '@client/l4_foundation/ui/shadcn/dropdown-menu'
import type {
  L2WorkbenchChatInputRuntime,
  L2WorkbenchModelCatalogState
} from '../l2-workbench-chat-input-runtime'
import { useL2WorkbenchModelPicker } from '../hooks/l2-workbench-model-picker'

const THINKING_LABELS = {
  off: 'thinkingOff',
  minimal: 'thinkingMinimal',
  low: 'thinkingLow',
  medium: 'thinkingMedium',
  high: 'thinkingHigh',
  xhigh: 'thinkingXhigh',
  max: 'thinkingMax'
} as const

export function L2WorkbenchModelPicker({
  source,
  runtime,
  catalog,
  current,
  label,
  title,
  disabled,
  triggerClassName,
  detailsClassName,
  onOpenSettings
}: {
  source: L2ChatSource
  runtime: L2WorkbenchChatInputRuntime
  catalog: L2WorkbenchModelCatalogState
  current: L2ChatRuntime['model']
  label: string
  title: string
  disabled: boolean
  triggerClassName: string
  detailsClassName: string
  onOpenSettings?: (target?: 'model-presets') => void
}): React.JSX.Element {
  const { t, i18n } = useTranslation('workbench')
  const [openSubmenu, setOpenSubmenu] = useState<string | null>(null)
  const { open, pending, error, changeOpen, refresh, submit } = useL2WorkbenchModelPicker(
    source,
    runtime,
    disabled
  )
  const selected = catalog.models.find(
    (model) => model.provider === current?.provider && model.modelId === current.modelId
  )
  const hasVirtualModels = catalog.models.some((model) => model.kind === 'virtual')
  const groups = hasVirtualModels
    ? [
        {
          key: 'virtual',
          label: t('modelAutomaticRouting', { defaultValue: '自动路由' }),
          models: catalog.models.filter((model) => model.kind === 'virtual')
        },
        {
          key: 'physical',
          label: t('modelFixed', { defaultValue: '固定模型' }),
          models: catalog.models.filter((model) => model.kind === 'physical')
        }
      ].filter((group) => group.models.length > 0)
    : [{ key: 'all', label: t('allModels'), models: catalog.models }]
  return (
    <DropdownMenu
      open={open}
      onOpenChange={(next) => {
        setOpenSubmenu(null)
        changeOpen(next)
      }}
    >
      <DropdownMenuTrigger
        render={
          <PromptInputButton
            title={title}
            aria-label={t('chooseModel')}
            className={triggerClassName}
          />
        }
      >
        <BotIcon className="size-4 shrink-0" />
        <span data-model-trigger-details className={detailsClassName}>
          <span className="flex min-w-0 items-center gap-2 pl-2">
            <span className="min-w-0 truncate">{label}</span>
            <ChevronDownIcon className="size-3 shrink-0" />
          </span>
        </span>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        side="top"
        className="flex max-h-96 w-72 flex-col overflow-hidden p-0"
      >
        <DropdownMenuGroup className="shrink-0 p-1">
          <DropdownMenuLabel>{t('currentModel')}</DropdownMenuLabel>
          <div className="mx-1 mb-1 flex items-center gap-2 rounded-md border bg-muted/50 px-2 py-2">
            <BotIcon className="size-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">
                {selected?.name || current?.modelId || t('selectModel')}
              </p>
              <p className="truncate text-xs text-muted-foreground">
                {current?.provider || t('selectModel')}
              </p>
            </div>
            {current ? (
              <span className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                {t('thinkingLevel', { level: t(THINKING_LABELS[current.thinkingLevel]) })}
              </span>
            ) : null}
          </div>
          {error ? (
            <p role="alert" className="wrap-anywhere px-2 py-1 text-sm text-destructive">
              {error}
            </p>
          ) : null}
          {pending ? (
            <p role="status" className="px-2 py-1 text-sm text-muted-foreground">
              {t('modelChanging', { defaultValue: '正在切换模型…' })}
            </p>
          ) : null}
        </DropdownMenuGroup>
        <DropdownMenuSeparator className="mx-0 my-0 shrink-0" />
        <div className="pi-desk-chat-scrollbar min-h-0 flex-auto overflow-x-hidden overflow-y-auto overscroll-contain p-1">
          {catalog.status === 'loading' ? (
            <DropdownMenuItem disabled>
              <RefreshCwIcon className="size-4 animate-spin" />
              {t('modelsLoading')}
            </DropdownMenuItem>
          ) : null}
          {catalog.status === 'error' ? (
            <>
              <p role="alert" className="wrap-anywhere px-2 py-1 text-sm text-destructive">
                {catalog.error || t('modelsFailed')}
              </p>
              <DropdownMenuItem closeOnClick={false} onClick={refresh}>
                <RefreshCwIcon className="size-4" />
                {t('retry')}
              </DropdownMenuItem>
            </>
          ) : null}
          {groups.map((group) => (
            <DropdownMenuGroup key={group.key}>
              <DropdownMenuLabel>{group.label}</DropdownMenuLabel>
              {group.models.map((model) => {
                const key = `${model.provider}:${model.modelId}`
                const isSelected =
                  current?.provider === model.provider && current.modelId === model.modelId
                return (
                  <DropdownMenuSub
                    key={key}
                    open={openSubmenu === key}
                    onOpenChange={(next) => {
                      setOpenSubmenu((previous) =>
                        next ? key : previous === key ? null : previous
                      )
                    }}
                  >
                    <DropdownMenuSubTrigger
                      disabled={disabled || pending}
                      label={model.name || model.modelId}
                    >
                      <span className="min-w-0 flex-1 truncate">{model.name || model.modelId}</span>
                      {model.input.includes('image') ? (
                        <ImageIcon className="size-3 text-muted-foreground" />
                      ) : null}
                      {isSelected ? <CheckIcon className="size-3 text-muted-foreground" /> : null}
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent>
                      <DropdownMenuGroup>
                        <DropdownMenuLabel>{t('thinkingLevels')}</DropdownMenuLabel>
                        {model.thinkingLevels.map((level) => (
                          <DropdownMenuItem
                            key={level}
                            disabled={disabled || pending}
                            closeOnClick={false}
                            onClick={() => {
                              setOpenSubmenu(null)
                              void submit(model, level)
                            }}
                          >
                            <span className="flex-1">{t(THINKING_LABELS[level])}</span>
                            {isSelected && current?.thinkingLevel === level ? (
                              <CheckIcon className="size-3 text-muted-foreground" />
                            ) : null}
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuGroup>
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                )
              })}
            </DropdownMenuGroup>
          ))}
          {catalog.status === 'ready' && catalog.models.length === 0 ? (
            <DropdownMenuItem disabled>{t('noModels')}</DropdownMenuItem>
          ) : null}
          {onOpenSettings &&
          (catalog.status === 'error' ||
            (catalog.status === 'ready' && catalog.models.length === 0)) ? (
            <DropdownMenuItem onClick={() => onOpenSettings()}>
              {t('openSettings', {
                defaultValue: (i18n.resolvedLanguage ?? i18n.language).startsWith('en')
                  ? 'Open settings'
                  : '打开设置'
              })}
            </DropdownMenuItem>
          ) : null}
        </div>
        {catalog.status === 'ready' || catalog.presets.length > 0 ? (
          <>
            <DropdownMenuSeparator className="mx-0 my-0 shrink-0" />
            <DropdownMenuGroup className="shrink-0 p-1">
              <DropdownMenuLabel>{t('presets')}</DropdownMenuLabel>
              {catalog.presets.length === 0 ? (
                <>
                  <p className="px-2 py-1 text-xs text-muted-foreground">
                    {t('commonCombinationsEmpty')}
                  </p>
                  {onOpenSettings ? (
                    <DropdownMenuItem
                      onClick={() => {
                        changeOpen(false)
                        onOpenSettings('model-presets')
                      }}
                    >
                      <Settings2Icon className="size-4" />
                      {t('configureCommonCombinations')}
                    </DropdownMenuItem>
                  ) : null}
                </>
              ) : null}
              {catalog.presets.map((preset, index) => (
                <DropdownMenuItem
                  key={`${preset.provider}:${preset.modelId}:${preset.thinkingLevel}:${index}`}
                  disabled={disabled || pending}
                  closeOnClick={false}
                  onClick={() => void submit(preset, preset.thinkingLevel)}
                >
                  <span
                    className="size-2 rounded-full bg-current"
                    style={preset.color ? { color: preset.color } : undefined}
                  />
                  <span className="min-w-0 flex-1 truncate">
                    {catalog.models.find(
                      (model) =>
                        model.provider === preset.provider && model.modelId === preset.modelId
                    )?.name || preset.modelId}
                  </span>
                  <span className="text-muted-foreground">
                    {t(THINKING_LABELS[preset.thinkingLevel])}
                  </span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
