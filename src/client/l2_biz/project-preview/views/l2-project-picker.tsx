'use client'

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ArrowLeftIcon,
  ChevronRightIcon,
  FolderIcon,
  FolderOpenIcon,
  LoaderCircleIcon
} from 'lucide-react'
import { Button } from '@client/l4_foundation/ui/shadcn/button'
import { Input } from '@client/l4_foundation/ui/shadcn/input'
import type { L2ProjectPicker } from '../hooks/l2-use-project-picker'

export function L2ProjectPickerView({
  picker,
  onSelect
}: {
  picker: L2ProjectPicker
  onSelect: (cwd: string) => void
}): React.JSX.Element {
  const { t } = useTranslation('projectHistory')
  const [path, setPath] = useState('')
  const browsing = picker.target.view === 'browser'
  const open = (): void => {
    const directory = path
      .trim()
      .replace(/^(["'])(.*)\1$/, '$2')
      .trim()
    if (directory) onSelect(directory)
  }
  return (
    <section
      className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-8 sm:px-6 sm:py-12"
      data-testid="project-picker"
    >
      <div>
        <h1 className="text-xl font-semibold">{t('chooseProject')}</h1>
        <p className="mt-2 text-sm text-muted-foreground">{t('serverDirectoryHint')}</p>
      </div>
      <form
        onSubmit={(event) => {
          event.preventDefault()
          open()
        }}
        className="space-y-2"
      >
        <label htmlFor="project-directory" className="text-sm font-medium">
          {t('directoryPath')}
        </label>
        <div className="flex gap-2">
          <Input
            id="project-directory"
            value={path}
            onChange={(event) => setPath(event.target.value)}
            placeholder={t('directoryPlaceholder')}
            autoComplete="off"
            className="min-w-0 flex-1 font-mono"
            onKeyDown={(event) => {
              if (event.key === 'Enter' && event.nativeEvent.isComposing) event.preventDefault()
            }}
          />
          <Button type="submit" disabled={!path.trim()}>
            {t('openProject')}
          </Button>
        </div>
      </form>
      <div className="min-w-0">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <Button
            variant={browsing ? 'ghost' : 'secondary'}
            onClick={picker.showProjects}
            disabled={picker.loading}
          >
            {t('recentProjects')}
          </Button>
          <Button
            variant={browsing ? 'secondary' : 'ghost'}
            onClick={() => picker.browse(null)}
            disabled={picker.loading}
          >
            <FolderOpenIcon className="size-4" />
            {t('browseDirectories')}
          </Button>
        </div>
        {picker.error ? (
          <div role="alert" className="space-y-3 rounded-lg border p-4">
            <p className="break-words text-sm text-destructive">{picker.error}</p>
            <Button variant="outline" onClick={picker.retry}>
              {t('retry')}
            </Button>
          </div>
        ) : picker.loading ? (
          <div role="status" className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <LoaderCircleIcon className="size-4 animate-spin" />
            {t('loadingDirectories')}
          </div>
        ) : browsing && picker.browser ? (
          <div>
            <div className="mb-2 flex items-center gap-2">
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={t('parentDirectory')}
                disabled={picker.browser.cwd === null}
                onClick={() => picker.browse(picker.browser?.parentCwd ?? null)}
              >
                <ArrowLeftIcon className="size-4" />
              </Button>
              <span className="min-w-0 flex-1 break-all font-mono text-sm">
                {picker.browser.cwd ?? t('directoryRoots')}
              </span>
              {picker.browser.cwd ? (
                <Button size="sm" onClick={() => onSelect(picker.browser!.cwd!)}>
                  {t('openThisDirectory')}
                </Button>
              ) : null}
            </div>
            <div className="divide-y rounded-lg border">
              {picker.browser.directories.map((directory) => (
                <button
                  key={directory.cwd}
                  type="button"
                  className="flex min-h-10 w-full items-center gap-2 px-3 py-2 text-left hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
                  onClick={() => picker.browse(directory.cwd)}
                >
                  <FolderIcon className="size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 break-all text-sm">{directory.name}</span>
                  <ChevronRightIcon className="size-4 shrink-0" />
                </button>
              ))}
              {!picker.browser.directories.length ? (
                <p className="p-4 text-sm text-muted-foreground">{t('noSubdirectories')}</p>
              ) : null}
            </div>
          </div>
        ) : (
          <div className="divide-y rounded-lg border">
            {picker.projects.map((project) => (
              <button
                key={project.cwd}
                type="button"
                className="flex min-h-14 w-full items-center gap-3 px-3 py-2 text-left hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
                onClick={() => onSelect(project.cwd)}
              >
                <FolderIcon className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">
                    {project.cwd.replaceAll('\\', '/').split('/').filter(Boolean).at(-1) ??
                      project.cwd}
                  </span>
                  <span className="block break-all font-mono text-xs text-muted-foreground">
                    {project.cwd}
                  </span>
                </span>
                <ChevronRightIcon className="size-4 shrink-0" />
              </button>
            ))}
            {!picker.projects.length ? (
              <p className="p-4 text-sm text-muted-foreground">{t('noRecentProjects')}</p>
            ) : null}
          </div>
        )}
      </div>
    </section>
  )
}
