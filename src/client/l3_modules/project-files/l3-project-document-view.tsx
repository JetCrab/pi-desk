'use client'
import {
  ArrowDownIcon,
  ArrowUpIcon,
  Columns2Icon,
  CopyIcon,
  FileCode2Icon,
  FoldVerticalIcon,
  ListOrderedIcon,
  LoaderCircleIcon,
  RefreshCwIcon,
  SearchIcon,
  WrapTextIcon
} from 'lucide-react'
import { useEffect, useImperativeHandle, useRef, useSyncExternalStore, type Ref } from 'react'
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
import { L3CodeSurfaceToolbarButton } from './l3-code-surface-toolbar-button'
import { buildL3FilePreviewHtml } from './l3-file-preview-html'

function fileName(path: string): string {
  return path.replaceAll('\\', '/').split('/').at(-1) ?? path
}
export interface L3ProjectDocumentHandle {
  focus(): void
}

export function L3ProjectDocumentView({
  ref: handleRef,
  runtime,
  compact,
  onEscape,
  onSwitchPane
}: {
  ref?: Ref<L3ProjectDocumentHandle>
  runtime: L3ProjectFileRuntime
  compact: boolean
  onEscape: () => void
  onSwitchPane?: () => void
}): React.JSX.Element {
  const { t } = useTranslation('projectFiles')
  const { wrapLines, diffViewMode, collapseUnchanged } = useL4CodePreferences()
  useSyncExternalStore(runtime.subscribe, runtime.getRevision, runtime.getRevision)
  const { activeDiff, activePath } = runtime.state
  const document = !activeDiff && activePath ? runtime.state.documents.get(activePath) : null
  const isHtml = Boolean(activePath && /\.html?$/i.test(activePath))
  const showSource = document?.status === 'text' && (!isHtml || document.viewMode === 'source')
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
        else diffRef.current?.focus()
      }
    }),
    [showSource]
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
      className="flex size-full min-h-0 min-w-0 flex-col outline-none"
      tabIndex={-1}
      onFocus={(event) => {
        if (event.target !== event.currentTarget) return
        if (showSource) previewRef.current?.focus()
        else diffRef.current?.focus()
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
              {isHtml && document?.status === 'text' && activePath ? (
                <div className="mr-auto flex shrink-0" role="group" aria-label={t('htmlMode')}>
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
                <L3CodeSurfaceToolbarButton
                  label={t('reloadCurrentFile')}
                  onClick={() => runtime.reloadFile(activePath)}
                >
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
        ) : isHtml && document.viewMode === 'preview' ? (
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
            savedState={document.editorState}
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
