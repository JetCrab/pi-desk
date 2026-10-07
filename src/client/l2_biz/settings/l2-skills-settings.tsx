'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  FolderTreeIcon,
  LoaderCircleIcon,
  PanelLeftCloseIcon,
  PanelLeftOpenIcon,
  RefreshCwIcon
} from 'lucide-react'
import type { L2SkillFileGetRequest } from '@common/l2_biz/settings/l2-skills-contract'
import { useL4AppSocket } from '@client/l4_foundation/realtime/app-socket/l4-app-socket'
import { useL4AppToast } from '@client/l4_foundation/ui/l4-app-toast'
import {
  L4AppDialogContent,
  L4AppDialogHeader,
  L4AppDialogRoot,
  L4AppDialogTitle
} from '@client/l4_foundation/ui/l4-app-dialog'
import { Button } from '@client/l4_foundation/ui/shadcn/button'
import { cn } from '@client/l4_foundation/lib/l4-utils'
import { copyL2SkillFilePath, createL2SkillsBiz } from './l2-skills-biz'
import {
  l2SkillScopeKey,
  useL2SkillsCatalog,
  type L2SkillProject
} from './hooks/l2-use-skills-catalog'
import { useL2SkillsEditor } from './hooks/l2-use-skills-editor'
import { L2SkillsEditorView } from './views/l2-skills-editor-view'
import { L2SkillsLeaveDialog } from './views/l2-skills-leave-dialog'
import { L2SkillsTree } from './views/l2-skills-tree'

interface SkillsProps {
  projects: readonly L2SkillProject[]
  focusedCwd: string | null
  onBeforeLeaveChange: (handler: (() => Promise<boolean>) | null) => void
}

export function L2SkillsSettings({
  projects,
  focusedCwd,
  onBeforeLeaveChange
}: SkillsProps): React.JSX.Element {
  const { t } = useTranslation('skills')
  const { clientId } = useL4AppSocket()
  const toast = useL4AppToast()
  const biz = useMemo(() => createL2SkillsBiz(clientId), [clientId])
  const catalog = useL2SkillsCatalog(biz, projects)
  const { loadScope } = catalog
  const onSaved = useCallback(
    (cwd: string | null): void => {
      void loadScope(cwd)
    },
    [loadScope]
  )
  const editor = useL2SkillsEditor(biz, onSaved)
  const { document: activeDocument, open: openDocument } = editor
  const [query, setQuery] = useState('')
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [treeVisible, setTreeVisible] = useState(true)
  const initialized = useRef(false)
  const initialCwd = useRef(focusedCwd)

  useEffect(() => {
    onBeforeLeaveChange(editor.beforeLeave)
    return () => onBeforeLeaveChange(null)
  }, [editor.beforeLeave, onBeforeLeaveChange])

  useEffect(() => {
    if (initialized.current || activeDocument) return
    const preferred = catalog.scopes[l2SkillScopeKey(initialCwd.current)]
    if (!preferred || preferred.loading) return
    const global = catalog.scopes[l2SkillScopeKey(null)]
    const preferredSkill = preferred.data?.skills[0]
    if (!preferredSkill && (!global || global.loading)) return
    const skill = preferredSkill ?? global?.data?.skills[0]
    initialized.current = true
    if (skill)
      void openDocument({
        cwd: preferredSkill ? initialCwd.current : null,
        skillPath: skill.skillPath,
        path: skill.skillPath.split('/').at(-1)!
      })
  }, [catalog.scopes, activeDocument, openDocument])

  const openFile = useCallback(
    async (target: L2SkillFileGetRequest): Promise<boolean> => {
      const opened = await openDocument(target)
      if (opened) setDrawerOpen(false)
      return opened
    },
    [openDocument]
  )

  const refresh = (): void => {
    for (const key of Object.keys(catalog.scopes))
      void catalog.loadScope(JSON.parse(key) as string | null)
    for (const key of Object.keys(catalog.directories)) {
      const [cwd, skillPath, path] = JSON.parse(key) as [string | null, string, string]
      void catalog.loadDirectory({ cwd, skillPath, path })
    }
  }
  const copy = async (): Promise<void> => {
    if (!editor.document) return
    try {
      await copyL2SkillFilePath(editor.document.target)
      toast.success(t('pathCopied'))
    } catch {
      toast.error(t('copyFailed'))
    }
  }
  const selected = editor.document?.target ?? null
  const skill = selected
    ? (catalog.scopes[l2SkillScopeKey(selected.cwd)]?.data?.skills.find(
        (item) => item.skillPath === selected.skillPath
      ) ?? null)
    : null
  const refreshing =
    Object.values(catalog.scopes).some((state) => state.loading) ||
    Object.values(catalog.directories).some((state) => state.loading)
  const treeProps = {
    projects,
    focusedCwd,
    query,
    onQuery: setQuery,
    scopes: catalog.scopes,
    directories: catalog.directories,
    selected,
    pending: editor.openingTarget,
    onLoadScope: catalog.loadScope,
    onLoadDirectory: catalog.loadDirectory,
    onOpenFile: openFile
  }

  return (
    <section
      aria-label={t('skillsManagement')}
      className="flex h-full min-h-0 flex-col bg-background"
    >
      <header className="flex min-h-12 shrink-0 items-center gap-2 border-b px-4 py-2">
        <Button
          variant="ghost"
          size="icon"
          className="lg:hidden"
          aria-label={t('openSkillsFolder')}
          onClick={() => setDrawerOpen(true)}
        >
          <FolderTreeIcon className="size-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="hidden lg:inline-flex"
          aria-label={t(treeVisible ? 'collapseSkillsFolder' : 'expandSkillsFolder')}
          onClick={() => setTreeVisible(!treeVisible)}
        >
          {treeVisible ? (
            <PanelLeftCloseIcon className="size-4" />
          ) : (
            <PanelLeftOpenIcon className="size-4" />
          )}
        </Button>
        <h2 className="text-xl font-semibold">Skills</h2>
        <div className="flex-1" />
        <Button
          variant="ghost"
          size="sm"
          disabled={refreshing}
          aria-label={t('refreshSkillsFolder')}
          onClick={refresh}
        >
          {refreshing ? (
            <LoaderCircleIcon className="size-3.5 animate-spin" />
          ) : (
            <RefreshCwIcon className="size-3.5" />
          )}
          {t('refreshFolder')}
        </Button>
      </header>
      <div className="flex min-h-0 flex-1">
        <aside
          aria-label={t('skillsProjectFolder')}
          className={cn(
            'hidden w-64 shrink-0 border-r bg-sidebar xl:w-72',
            treeVisible && 'lg:block'
          )}
        >
          <L2SkillsTree {...treeProps} />
        </aside>
        <main className="min-h-0 min-w-0 flex-1">
          <L2SkillsEditorView
            document={editor.document}
            skill={skill}
            dirty={editor.dirty}
            loading={editor.loading}
            saving={editor.saving}
            opening={Boolean(editor.openingTarget)}
            wrapLines={editor.wrapLines}
            onWrapLines={() => editor.setWrapLines(!editor.wrapLines)}
            onChange={editor.change}
            onSave={() => void editor.save()}
            onReload={() => {
              if (selected) void openFile(selected)
            }}
            onCopy={() => void copy()}
          />
        </main>
      </div>
      <L4AppDialogRoot open={drawerOpen} onOpenChange={setDrawerOpen}>
        <L4AppDialogContent
          className="left-0 top-0 z-[130] h-dvh max-h-dvh w-[min(360px,calc(100dvw-2rem))] max-w-none translate-x-0 translate-y-0 rounded-l-none"
          finalFocus={false}
        >
          <L4AppDialogHeader className="shrink-0 border-b px-4 py-3 pr-12">
            <L4AppDialogTitle>{t('skillsFolderTitle')}</L4AppDialogTitle>
          </L4AppDialogHeader>
          <div className="min-h-0 flex-1">
            <L2SkillsTree {...treeProps} />
          </div>
        </L4AppDialogContent>
      </L4AppDialogRoot>
      <L2SkillsLeaveDialog
        open={editor.confirmOpen}
        saving={editor.saving}
        path={selected?.path ?? null}
        error={editor.document?.error ?? null}
        onDecide={editor.decide}
      />
    </section>
  )
}
