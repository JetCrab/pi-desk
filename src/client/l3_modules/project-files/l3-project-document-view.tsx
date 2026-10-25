'use client'
import {
  ArrowDownIcon,
  ArrowUpIcon,
  Columns2Icon,
  CopyIcon,
  FileCode2Icon,
  FoldVerticalIcon,
  GitCompareArrowsIcon,
  ListOrderedIcon,
  LoaderCircleIcon,
  RefreshCwIcon,
  SearchIcon,
  WrapTextIcon
} from 'lucide-react'
import {
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  useSyncExternalStore,
  type Ref
} from 'react'
import { useTranslation } from 'react-i18next'
import { copyL4BrowserText } from '@client/l4_foundation/lib/l4-browser-clipboard'
import {
  L4CodePreview,
  type L4CodePreviewHandle
} from '@client/l4_foundation/ui/code/l4-code-preview'
import { L4CodeDiff, type L4CodeDiffHandle } from '@client/l4_foundation/ui/code/l4-code-diff'
import { useL4CodePreferences } from '@client/l4_foundation/ui/code/l4-code-preferences'
import { L4ImageViewer } from '@client/l4_foundation/ui/l4-image-viewer'
import { useL4AppToast } from '@client/l4_foundation/ui/l4-app-toast'
import { Button } from '@client/l4_foundation/ui/shadcn/button'
import type { L3ProjectFileRuntime } from './l3-project-file-runtime'
import type { L3ProjectGitBrowser } from './l3-project-git-runtime'
import { useL3ProjectDocumentGit } from './l3-project-document-git'
import { L3CodeSurfaceToolbarButton } from './l3-code-surface-toolbar-button'
import { buildL3FilePreviewHtml } from './l3-file-preview-html'
import { L3MarkdownPreview } from './l3-markdown-preview'
import { getL3ProjectTextPreviewKind } from './l3-project-text-preview'

function fileName(path: string): string {
  return path.replaceAll('\\', '/').split('/').at(-1) ?? path
}
export interface L3ProjectDocumentHandle {
  focus(): void
}

export function L3ProjectDocumentView({
  ref: handleRef,
  runtime,
  gitRuntime,
  compact,
  visible = true,
  onEscape,
  onSwitchPane
}: {
  ref?: Ref<L3ProjectDocumentHandle>
  runtime: L3ProjectFileRuntime
  gitRuntime: L3ProjectGitBrowser
  compact: boolean
  visible?: boolean
  onEscape: () => void
  onSwitchPane?: () => void
}): React.JSX.Element {
  const { t } = useTranslation('projectFiles')
  const { wrapLines, diffViewMode, collapseUnchanged } = useL4CodePreferences()
  useSyncExternalStore(runtime.subscribe, runtime.getRevision, runtime.getRevision)
  const { activeDiff, activePath } = runtime.state
  const document = !activeDiff && activePath ? runtime.state.documents.get(activePath) : null
  const previewKind = activePath ? getL3ProjectTextPreviewKind(activePath) : null
  const showSource = document?.status === 'text' && (!previewKind || document.viewMode === 'source')
  const hostRef = useRef<HTMLDivElement>(null)
  const previewRef = useRef<L4CodePreviewHandle>(null)
  const diffRef = useRef<L4CodeDiffHandle>(null)
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const toast = useL4AppToast()
  const escape = onEscape
  useImperativeHandle(
    handleRef,
    () => ({
      focus(): void {
        if (showSource) previewRef.current?.focus()
        else if (activeDiff) diffRef.current?.focus()
        else
          hostRef.current?.querySelector<HTMLElement>('[data-testid="markdown-preview"]')?.focus()
      }
    }),
    [activeDiff, showSource]
  )
  useEffect(() => {
    const receive = (event: MessageEvent): void => {
      if (!iframeRef.current || event.source !== iframeRef.current.contentWindow) return
      if (event.data === 'pi-desk:file-escape') onEscape()
      if (event.data === 'pi-desk:file-switch-pane') onSwitchPane?.()
    }
    window.addEventListener('message', receive)
    return () => window.removeEventListener('message', receive)
  }, [onEscape, onSwitchPane])
  const savePosition = (): void => {
    if (activePath && previewRef.current)
      runtime.saveEditorState(activePath, previewRef.current.getViewState())
  }
  const { refresh, unavailable } = useL3ProjectDocumentGit(
    runtime,
    gitRuntime,
    hostRef,
    savePosition,
    visible
  )
  const comparison = document?.status === 'text' ? document.comparison : undefined
  const [computed, setComputed] = useState<{
    original: string
    modified: string
    count: number | null
  } | null>(null)
  const count =
    comparison?.status === 'ready' &&
    document?.status === 'text' &&
    computed?.original === comparison.original.content &&
    computed.modified === document.content
      ? computed.count
      : undefined
  const openDiff = (line?: number): void => {
    if (!activePath) return
    savePosition()
    runtime.openFileDiff(activePath, line)
  }
  const gitStatus =
    unavailable || comparison?.status === 'error'
      ? t('gitMarkersFailed')
      : comparison?.status === 'unavailable' || (comparison?.status === 'ready' && count === null)
        ? t('gitMarkersUnavailable')
        : comparison?.status === 'loading' ||
            (comparison?.status === 'ready' && count === undefined)
          ? t('gitMarkersLoading')
          : comparison?.status === 'ready'
            ? t('gitChangesCount', { count })
            : null
  const copyText = (): void => {
    if (document?.status !== 'text') return
    const selection = previewRef.current?.getSelectionText() ?? ''
    void copyL4BrowserText(selection || document.content).then((copied) => {
      if (copied) toast.success(t(selection ? 'selectedCodeCopied' : 'allCodeCopied'))
      else toast.error(t('copyContentFailed'))
    })
  }
  return (
    <div
      ref={hostRef}
      className="flex size-full min-h-0 min-w-0 flex-col outline-none"
      tabIndex={-1}
      onFocus={(event) => {
        if (event.target !== event.currentTarget) return
        if (showSource) previewRef.current?.focus()
        else if (activeDiff) diffRef.current?.focus()
        else
          hostRef.current?.querySelector<HTMLElement>('[data-testid="markdown-preview"]')?.focus()
      }}
    >
      {activeDiff || activePath ? (
        <div
          className="flex min-h-9 shrink-0 flex-wrap items-center justify-end gap-2 border-b px-3 py-1"
          aria-label={t('fileActions')}
        >
          {activeDiff ? (
            <>
              <span className="mr-auto shrink-0 px-1 text-xs text-muted-foreground">
                {activeDiff.label ?? t('headToWorking')}
                {activeDiff.status === 'text' &&
                activeDiff.original.content === activeDiff.modified.content
                  ? t('noDiffChanges')
                  : ''}
              </span>
              <L3CodeSurfaceToolbarButton
                label={t('previousChange')}
                onClick={() => diffRef.current?.previousChange()}
              >
                <ArrowUpIcon className="size-4" />
              </L3CodeSurfaceToolbarButton>
              <L3CodeSurfaceToolbarButton
                label={t('nextChange')}
                onClick={() => diffRef.current?.nextChange()}
              >
                <ArrowDownIcon className="size-4" />
              </L3CodeSurfaceToolbarButton>
              {!compact ? (
                <L3CodeSurfaceToolbarButton
                  label={diffViewMode === 'side-by-side' ? t('inlineDiff') : t('sideBySideDiff')}
                  active={diffViewMode === 'inline'}
                  onClick={() =>
                    runtime.setDiffViewMode(
                      diffViewMode === 'side-by-side' ? 'inline' : 'side-by-side'
                    )
                  }
                >
                  <Columns2Icon className="size-4" />
                </L3CodeSurfaceToolbarButton>
              ) : null}
              <L3CodeSurfaceToolbarButton
                label={t(wrapLines ? 'wrapOff' : 'wrapOn')}
                active={wrapLines}
                onClick={() => runtime.setDiffWrapLines(!wrapLines)}
              >
                <WrapTextIcon className="size-4" />
              </L3CodeSurfaceToolbarButton>
              <L3CodeSurfaceToolbarButton
                label={t(collapseUnchanged ? 'expandUnchanged' : 'collapseUnchanged')}
                active={collapseUnchanged}
                onClick={() => runtime.setDiffCollapseUnchanged(!collapseUnchanged)}
              >
                <FoldVerticalIcon className="size-4" />
              </L3CodeSurfaceToolbarButton>
              <L3CodeSurfaceToolbarButton
                label={t('reloadDiff')}
                onClick={() => runtime.reloadDiff()}
              >
                <RefreshCwIcon className="size-4" />
              </L3CodeSurfaceToolbarButton>
            </>
          ) : (
            <>
              {previewKind && document?.status === 'text' && activePath ? (
                <div
                  className="mr-auto flex shrink-0"
                  role="group"
                  aria-label={t(previewKind === 'markdown' ? 'markdownMode' : 'htmlMode')}
                >
                  {(['preview', 'source'] as const).map((mode) => (
                    <Button
                      key={mode}
                      variant={document.viewMode === mode ? 'secondary' : 'ghost'}
                      size="sm"
                      aria-pressed={document.viewMode === mode}
                      onClick={() => {
                        savePosition()
                        runtime.setTextViewMode(activePath, mode)
                      }}
                    >
                      {t(mode === 'preview' ? 'previewMode' : 'sourceMode')}
                    </Button>
                  ))}
                </div>
              ) : null}
              {showSource && gitStatus ? (
                <span
                  data-testid="file-git-status"
                  role="status"
                  className="mr-auto min-w-0 truncate text-xs text-muted-foreground"
                  title={comparison?.status === 'error' ? comparison.error : gitStatus}
                >
                  {compact && comparison?.status === 'ready' && typeof count === 'number'
                    ? t('gitChangesCompact', { count })
                    : gitStatus}
                </span>
              ) : null}
              {showSource && comparison?.status === 'ready' ? (
                <>
                  {typeof count === 'number' && count > 0 ? (
                    <>
                      <L3CodeSurfaceToolbarButton
                        label={t('previousChange')}
                        onClick={() => previewRef.current?.previousChange()}
                      >
                        <ArrowUpIcon className="size-4" />
                      </L3CodeSurfaceToolbarButton>
                      <L3CodeSurfaceToolbarButton
                        label={t('nextChange')}
                        onClick={() => previewRef.current?.nextChange()}
                      >
                        <ArrowDownIcon className="size-4" />
                      </L3CodeSurfaceToolbarButton>
                    </>
                  ) : null}
                  <L3CodeSurfaceToolbarButton label={t('viewDiff')} onClick={() => openDiff()}>
                    <GitCompareArrowsIcon className="size-4" />
                  </L3CodeSurfaceToolbarButton>
                </>
              ) : null}
              {showSource && activePath ? (
                <>
                  <L3CodeSurfaceToolbarButton
                    label={t('findInFile')}
                    onClick={() => previewRef.current?.openSearch()}
                  >
                    <SearchIcon className="size-4" />
                  </L3CodeSurfaceToolbarButton>
                  {!compact ? (
                    <L3CodeSurfaceToolbarButton
                      label={t('goToLine')}
                      onClick={() => previewRef.current?.gotoLine()}
                    >
                      <ListOrderedIcon className="size-4" />
                    </L3CodeSurfaceToolbarButton>
                  ) : null}
                  <L3CodeSurfaceToolbarButton
                    label={t(wrapLines ? 'wrapOff' : 'wrapOn')}
                    active={wrapLines}
                    onClick={() => runtime.setWrapLines(activePath, !wrapLines)}
                  >
                    <WrapTextIcon className="size-4" />
                  </L3CodeSurfaceToolbarButton>
                  <L3CodeSurfaceToolbarButton label={t('copySelectionOrAll')} onClick={copyText}>
                    <CopyIcon className="size-4" />
                  </L3CodeSurfaceToolbarButton>
                </>
              ) : null}
              {activePath ? (
                <L3CodeSurfaceToolbarButton label={t('reloadCurrentFile')} onClick={refresh}>
                  <RefreshCwIcon className="size-4" />
                </L3CodeSurfaceToolbarButton>
              ) : null}
            </>
          )}
        </div>
      ) : null}
      <div className="min-h-0 flex-1 overflow-hidden pb-[env(safe-area-inset-bottom)]">
        {activeDiff ? (
          activeDiff.status === 'text' ? (
            <L4CodeDiff
              key={`${activeDiff.repositoryRoot}:${activeDiff.path}`}
              ref={diffRef}
              original={activeDiff.original}
              modified={activeDiff.modified}
              viewMode={compact ? 'inline' : diffViewMode}
              savedState={activeDiff.editorState}
              initialLine={activeDiff.initialLine}
              onSaveState={(position) => runtime.saveDiffState(activeDiff, position)}
              onEscape={escape}
            />
          ) : activeDiff.status === 'metadata' ? (
            <div className="grid h-full grid-cols-1 gap-4 overflow-auto p-4 md:grid-cols-2">
              <pre className="whitespace-pre-wrap break-all text-sm">
                {activeDiff.originalMetadata}
              </pre>
              <pre className="whitespace-pre-wrap break-all text-sm">
                {activeDiff.modifiedMetadata}
              </pre>
            </div>
          ) : activeDiff.status === 'loading' ? (
            <Loading />
          ) : (
            <div className="flex size-full flex-col items-center justify-center gap-3 p-6 text-center text-sm">
              <p className="text-muted-foreground">
                {activeDiff.status === 'binary'
                  ? t('binaryDiffUnavailable')
                  : activeDiff.status === 'too_large'
                    ? t('largeDiffUnavailable')
                    : activeDiff.error}
              </p>
              {activeDiff.status === 'error' ? (
                <Button variant="outline" onClick={() => runtime.reloadDiff()}>
                  {t('readAgain')}
                </Button>
              ) : null}
            </div>
          )
        ) : !activePath || !document ? (
          <div
            data-testid="file-workspace-empty"
            className="flex size-full flex-col items-center justify-center gap-3 p-6 text-sm text-muted-foreground"
          >
            <FileCode2Icon className="size-6" />
            {t('noOpenFile')}
          </div>
        ) : document.status === 'loading' || document.status === 'unloaded' ? (
          <Loading />
        ) : document.status === 'error' ? (
          <div className="flex size-full flex-col items-center justify-center gap-3 p-6 text-center">
            <p role="alert" className="text-sm text-destructive">
              {document.error}
            </p>
            <Button variant="outline" onClick={() => runtime.reloadFile(activePath)}>
              {t('readAgain')}
            </Button>
          </div>
        ) : document.status === 'image' ? (
          <L4ImageViewer
            key={document.objectUrl}
            mode="inline"
            slides={[{ src: document.objectUrl, alt: activePath }]}
            ariaLabel={t('imageViewer', { name: fileName(activePath) })}
          />
        ) : previewKind === 'markdown' && document.viewMode === 'preview' ? (
          <L3MarkdownPreview
            key={activePath}
            content={document.content}
            label={t('markdownPreview', { name: activePath })}
            savedScrollTop={document.previewScrollTop}
            onScroll={(scrollTop) => runtime.savePreviewScrollTop(activePath, scrollTop)}
          />
        ) : previewKind === 'html' && document.viewMode === 'preview' ? (
          <iframe
            ref={iframeRef}
            className="block size-full border-0 bg-white"
            sandbox="allow-scripts"
            srcDoc={buildL3FilePreviewHtml(document.content)}
            title={t('htmlPreview', { name: activePath })}
          />
        ) : (
          <L4CodePreview
            key={activePath}
            ref={previewRef}
            path={activePath}
            content={document.content}
            size={document.size}
            originalContent={
              comparison?.status === 'ready' ? comparison.original.content : undefined
            }
            onChanges={(count) => {
              if (comparison?.status === 'ready')
                setComputed({
                  original: comparison.original.content,
                  modified: document.content,
                  count
                })
            }}
            onOpenDiff={openDiff}
            savedState={document.editorState}
            navigation={runtime.pendingNavigation}
            onNavigation={(target, exists) => runtime.consumeNavigation(target, exists)}
            onSaveState={(path, state) => runtime.saveEditorState(path, state)}
            onEscape={escape}
          />
        )}
      </div>
    </div>
  )
}

function Loading(): React.JSX.Element {
  const { t } = useTranslation('projectFiles')
  return (
    <div className="flex size-full items-center justify-center gap-2 text-sm text-muted-foreground">
      <LoaderCircleIcon className="size-4 animate-spin" />
      {t('loadingFile')}
    </div>
  )
}
