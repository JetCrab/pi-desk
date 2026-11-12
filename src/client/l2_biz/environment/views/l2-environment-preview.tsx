'use client'

import { useTranslation } from 'react-i18next'
import type {
  L2EnvironmentItem,
  L2EnvironmentPreviewResponse
} from '@common/l2_biz/environment/l2-environment-contract'
import { Button } from '@client/l4_foundation/ui/shadcn/button'
import { Input } from '@client/l4_foundation/ui/shadcn/input'
import { Checkbox } from '@client/l4_foundation/ui/shadcn/checkbox'
import {
  sourceL2EnvironmentDirectories,
  selectedL2EnvironmentItems,
  type L2EnvironmentState
} from '../l2-environment-runtime'
import { L2EnvironmentDirectory } from './l2-environment-directory'

export function L2EnvironmentNotices({
  title,
  values
}: {
  title: string
  values: readonly string[]
}): React.JSX.Element | null {
  if (!values.length) return null
  return (
    <div className="space-y-1 text-sm">
      <p className="font-medium">{title}</p>
      <ul className="list-disc space-y-1 pl-5 text-muted-foreground [overflow-wrap:anywhere]">
        {values.map((value, index) => (
          <li key={index}>{value}</li>
        ))}
      </ul>
    </div>
  )
}

export function L2EnvironmentPreview({
  preview,
  previewFresh,
  selectedIds,
  targets,
  overwrite,
  browser,
  disabled,
  onSelect,
  onTarget,
  onOverwrite,
  onBrowse,
  onCloseBrowser
}: {
  preview: L2EnvironmentPreviewResponse
  previewFresh: boolean
  selectedIds: readonly string[]
  targets: Readonly<Record<string, string>>
  overwrite: boolean
  browser: L2EnvironmentState['browser']
  disabled: boolean
  onSelect: (ids: readonly string[], checked: boolean) => void
  onTarget: (from: string, to: string) => void
  onOverwrite: (checked: boolean) => void
  onBrowse: (from: string, cwd: string | null) => void
  onCloseBrowser: () => void
}): React.JSX.Element {
  const { t } = useTranslation('settings')
  const selected = new Set(selectedIds)
  const items = selectedL2EnvironmentItems(preview, selectedIds)
  const sources = sourceL2EnvironmentDirectories(items)
  const conflicts = previewFresh ? items.flatMap((item) => item.conflicts) : []

  function renderItem(item: L2EnvironmentItem): React.JSX.Element {
    return (
      <li key={item.id} className="min-w-0 space-y-2 py-3">
        <label className="flex min-h-8 cursor-pointer items-start gap-2 text-sm">
          <Checkbox
            aria-label={t('environment.selectItem', { title: item.title })}
            className="mt-0.5 shrink-0"
            checked={selected.has(item.id)}
            disabled={disabled}
            onCheckedChange={(checked) => onSelect([item.id], checked === true)}
          />
          <span className="min-w-0 space-y-1 [overflow-wrap:anywhere]">
            <span className="block font-medium">{item.title}</span>
            {item.sessionId ? (
              <span className="block font-mono text-xs text-muted-foreground">
                {item.sessionId}
              </span>
            ) : null}
            <span className="block text-xs text-muted-foreground">
              {t('environment.itemSize', { files: item.files, bytes: item.bytes })}
            </span>
          </span>
        </label>
        {previewFresh ? (
          <L2EnvironmentNotices title={t('environment.conflicts')} values={item.conflicts} />
        ) : null}
        <L2EnvironmentNotices title={t('environment.warnings')} values={item.warnings} />
      </li>
    )
  }

  return (
    <div className="min-w-0 space-y-6">
      <div className="space-y-2">
        <h3 className="text-sm font-semibold">{t('environment.selection')}</h3>
        <p className="text-sm text-muted-foreground">
          {t('environment.sourcePlatform', {
            platform: { win32: 'Windows', darwin: 'macOS', linux: 'Linux' }[preview.sourcePlatform]
          })}
        </p>
        <div className="flex flex-wrap gap-2">
          {(['config', 'session', 'all'] as const).map((scope) => (
            <Button
              key={scope}
              type="button"
              variant="outline"
              disabled={disabled}
              onClick={() => {
                onSelect(
                  preview.items.map((item) => item.id),
                  false
                )
                onSelect(
                  preview.items
                    .filter((item) => scope === 'all' || item.category === scope)
                    .map((item) => item.id),
                  true
                )
              }}
            >
              {t(
                `environment.${scope === 'config' ? 'onlyConfig' : scope === 'session' ? 'onlySessions' : 'selectAll'}`
              )}
            </Button>
          ))}
        </div>
        <L2EnvironmentNotices title={t('environment.warnings')} values={preview.warnings} />
      </div>
      {(['config', 'plugin-data', 'session'] as const).map((category) => {
        const categoryItems = preview.items.filter((item) => item.category === category)
        const count = categoryItems.filter((item) => selected.has(item.id)).length
        const groups = new Map<string, L2EnvironmentItem[]>()
        if (category === 'session')
          for (const item of categoryItems) {
            const cwd = item.sourceCwd ?? ''
            groups.set(cwd, [...(groups.get(cwd) ?? []), item])
          }
        return (
          <fieldset key={category} className="min-w-0 rounded-xl border p-4" disabled={disabled}>
            <legend className="px-1 text-sm font-semibold">
              {t(
                `environment.${category === 'config' ? 'config' : category === 'plugin-data' ? 'pluginData' : 'sessions'}`
              )}
            </legend>
            <label className="flex min-h-8 cursor-pointer items-center gap-2 text-sm font-medium">
              <Checkbox
                aria-label={t('environment.selectCategory', {
                  category: t(
                    `environment.${category === 'config' ? 'config' : category === 'plugin-data' ? 'pluginData' : 'sessions'}`
                  )
                })}
                checked={count > 0 && count === categoryItems.length}
                indeterminate={count > 0 && count < categoryItems.length}
                disabled={disabled || !categoryItems.length}
                onCheckedChange={(checked) =>
                  onSelect(
                    categoryItems.map((item) => item.id),
                    checked === true
                  )
                }
              />
              <span>
                {t(
                  `environment.${category === 'config' ? 'config' : category === 'plugin-data' ? 'pluginData' : 'sessions'}`
                )}{' '}
                <span className="text-muted-foreground">
                  {count} / {categoryItems.length}
                </span>
              </span>
            </label>
            {!categoryItems.length ? (
              <p className="mt-2 text-sm text-muted-foreground">{t('environment.noItems')}</p>
            ) : category === 'session' ? (
              <>
                <p className="mt-2 text-sm text-muted-foreground">{t('environment.sessionHint')}</p>
                {[...groups].map(([cwd, group]) => (
                  <div key={cwd} className="mt-3 min-w-0 border-t pt-3">
                    <label className="flex min-h-8 cursor-pointer items-start gap-2 text-sm font-medium">
                      <Checkbox
                        className="mt-0.5 shrink-0"
                        checked={group.every((item) => selected.has(item.id))}
                        indeterminate={
                          group.some((item) => selected.has(item.id)) &&
                          !group.every((item) => selected.has(item.id))
                        }
                        disabled={disabled}
                        onCheckedChange={(checked) =>
                          onSelect(
                            group.map((item) => item.id),
                            checked === true
                          )
                        }
                      />
                      <span className="min-w-0 font-mono [overflow-wrap:anywhere]">
                        {cwd || t('environment.noDirectory')}
                      </span>
                    </label>
                    <ul className="divide-y">{group.map(renderItem)}</ul>
                  </div>
                ))}
              </>
            ) : (
              <ul className="divide-y">{categoryItems.map(renderItem)}</ul>
            )}
          </fieldset>
        )
      })}
      {sources.length ? (
        <section className="space-y-4" aria-label={t('environment.mappings')}>
          <div className="space-y-1">
            <h3 className="text-sm font-semibold">{t('environment.mappings')}</h3>
            <p className="text-sm text-muted-foreground">{t('environment.mappingHint')}</p>
          </div>
          {sources.map((from, index) => (
            <div key={from} className="min-w-0 space-y-2">
              <label
                htmlFor={`environment-target-${index}`}
                className="block break-all font-mono text-sm"
              >
                {from}
              </label>
              <div className="flex flex-wrap gap-2">
                <Input
                  id={`environment-target-${index}`}
                  value={targets[from] ?? ''}
                  placeholder={t('environment.target')}
                  disabled={disabled}
                  className="min-w-0 flex-1 basis-48"
                  onChange={(event) => onTarget(from, event.target.value)}
                />
                <Button
                  type="button"
                  variant="outline"
                  disabled={disabled}
                  onClick={() => onBrowse(from, null)}
                >
                  {t('environment.browse')}
                </Button>
              </div>
            </div>
          ))}
          {browser && sources.includes(browser.from) ? (
            <L2EnvironmentDirectory
              key={browser.from}
              browser={browser}
              disabled={disabled}
              onBrowse={(cwd) => onBrowse(browser.from, cwd)}
              onChoose={(cwd) => {
                onTarget(browser.from, cwd)
                onCloseBrowser()
              }}
              onClose={onCloseBrowser}
            />
          ) : null}
        </section>
      ) : null}
      <div className="space-y-2">
        <label className="flex min-h-8 cursor-pointer items-center gap-2 text-sm font-medium">
          <Checkbox
            checked={overwrite}
            disabled={disabled || !previewFresh}
            onCheckedChange={(checked) => onOverwrite(checked === true)}
          />
          {t('environment.overwrite')}
        </label>
        <p className="text-sm text-muted-foreground">{t('environment.overwriteHint')}</p>
        {conflicts.length ? (
          <p className="text-sm font-medium">
            {t('environment.conflicts')} · {conflicts.length}
          </p>
        ) : null}
      </div>
    </div>
  )
}
