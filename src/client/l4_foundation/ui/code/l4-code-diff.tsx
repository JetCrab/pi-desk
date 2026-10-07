'use client'

import { LoaderCircleIcon } from 'lucide-react'
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ForwardedRef
} from 'react'
import { useTranslation } from 'react-i18next'
import type { editor } from 'monaco-editor'
import {
  createL4MonacoModelUri,
  getL4MonacoLanguage,
  getL4MonacoTheme,
  loadL4Monaco,
  getL4MonacoTypography,
  observeL4MonacoTheme,
  observeL4MonacoTypography
} from './l4-monaco-runtime'

import { bindL4MonacoPreviewEscape } from './l4-monaco-preview-escape'
import { useL4CodePreferences } from './l4-code-preferences'

export type L4CodeDiffState = editor.IDiffEditorViewState

export interface L4CodeDiffHandle {
  previousChange: () => void
  nextChange: () => void
  focus: () => void
}

interface L4CodeDiffSide {
  path: string
  content: string
}

interface L4CodeDiffProps {
  original: L4CodeDiffSide
  modified: L4CodeDiffSide
  viewMode: 'side-by-side' | 'inline'
  onEscape?: () => void
  savedState?: L4CodeDiffState | null
  onSaveState?: (state: L4CodeDiffState | null) => void
}

function L4CodeDiffComponent(
  { original, modified, viewMode, onEscape, savedState, onSaveState }: L4CodeDiffProps,
  ref: ForwardedRef<L4CodeDiffHandle>
): React.JSX.Element {
  const { t } = useTranslation('common')
  const { wrapLines, collapseUnchanged } = useL4CodePreferences()
  const hostRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<editor.IStandaloneDiffEditor | null>(null)
  const settingsRef = useRef({ viewMode, wrapLines, collapseUnchanged })
  const escapeRef = useRef(onEscape)
  const savedStateRef = useRef(savedState)
  const saveStateRef = useRef(onSaveState)

  useEffect(() => {
    escapeRef.current = onEscape
    savedStateRef.current = savedState
    saveStateRef.current = onSaveState
  }, [onEscape, onSaveState, savedState])
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [changeCount, setChangeCount] = useState<number | null>(null)

  useEffect(() => {
    settingsRef.current = { viewMode, wrapLines, collapseUnchanged }
  }, [collapseUnchanged, viewMode, wrapLines])

  useImperativeHandle(
    ref,
    () => ({
      previousChange(): void {
        editorRef.current?.goToDiff('previous')
      },
      nextChange(): void {
        editorRef.current?.goToDiff('next')
      },
      focus(): void {
        editorRef.current?.getModifiedEditor().focus()
      }
    }),
    []
  )

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    let active = true
    let diffEditor: editor.IStandaloneDiffEditor | null = null
    let originalModel: editor.ITextModel | null = null
    let modifiedModel: editor.ITextModel | null = null
    let stopThemeObserver = (): void => undefined
    let stopTypographyObserver = (): void => undefined
    const scrollListeners: { dispose(): void }[] = []

    queueMicrotask(() => {
      if (active) {
        setLoadState('loading')
        setChangeCount(null)
      }
    })
    void loadL4Monaco()
      .then((monaco) => {
        if (!active) return
        originalModel = monaco.editor.createModel(
          original.content,
          getL4MonacoLanguage(original.path, new TextEncoder().encode(original.content).length),
          createL4MonacoModelUri(monaco, original.path, 'diff-original')
        )
        modifiedModel = monaco.editor.createModel(
          modified.content,
          getL4MonacoLanguage(modified.path, new TextEncoder().encode(modified.content).length),
          createL4MonacoModelUri(monaco, modified.path, 'diff-modified')
        )
        const initialSettings = settingsRef.current
        diffEditor = monaco.editor.createDiffEditor(host, {
          theme: getL4MonacoTheme(),
          readOnly: true,
          domReadOnly: true,
          // EditContext 不遵循 domReadOnly，预览使用原生只读输入框避免唤起软键盘。
          editContext: false,
          originalEditable: false,
          automaticLayout: true,
          renderSideBySide: initialSettings.viewMode === 'side-by-side',
          useInlineViewWhenSpaceIsLimited: false,
          enableSplitViewResizing: true,
          diffAlgorithm: 'advanced',
          maxComputationTime: 5_000,
          hideUnchangedRegions: initialSettings.collapseUnchanged
            ? {
                enabled: true,
                revealLineCount: 3,
                minimumLineCount: 6,
                contextLineCount: 3
              }
            : { enabled: false },
          minimap: { enabled: false },
          stickyScroll: { enabled: false },
          scrollBeyondLastLine: false,
          smoothScrolling: true,
          // Diff 专用覆盖同时控制两侧，普通 wordWrap 不能保证原始侧同步。
          diffWordWrap: initialSettings.wrapLines ? 'on' : 'off',
          wrappingIndent: 'same',
          ...getL4MonacoTypography(),
          lineNumbersMinChars: 3,
          renderValidationDecorations: 'off',
          renderWhitespace: 'selection',
          unicodeHighlight: { nonBasicASCII: false },
          padding: { top: 10, bottom: 10 },
          overviewRulerBorder: false,
          contextmenu: true,
          ariaLabel: t('gitDiffReadOnly')
        })
        diffEditor.setModel({ original: originalModel, modified: modifiedModel })
        scrollListeners.push(
          diffEditor.onDidUpdateDiff(() => {
            if (active) setChangeCount(diffEditor?.getLineChanges()?.length ?? null)
          })
        )
        if (savedStateRef.current) diffEditor.restoreViewState(savedStateRef.current)
        const save = (): void => saveStateRef.current?.(diffEditor?.saveViewState() ?? null)
        scrollListeners.push(
          diffEditor.getOriginalEditor().onDidScrollChange(save),
          diffEditor.getModifiedEditor().onDidScrollChange(save)
        )
        if (escapeRef.current) {
          bindL4MonacoPreviewEscape(diffEditor.getOriginalEditor(), monaco.KeyCode.Escape, () =>
            escapeRef.current?.()
          )
          bindL4MonacoPreviewEscape(diffEditor.getModifiedEditor(), monaco.KeyCode.Escape, () =>
            escapeRef.current?.()
          )
        }
        editorRef.current = diffEditor
        stopThemeObserver = observeL4MonacoTheme((theme) => monaco.editor.setTheme(theme))
        stopTypographyObserver = observeL4MonacoTypography((typography) =>
          diffEditor?.updateOptions(typography)
        )
        setLoadState('ready')
      })
      .catch((error: unknown) => {
        if (!active) return
        console.error('[Pi Desk][CodeDiff] Monaco 加载失败', {
          originalPath: original.path,
          modifiedPath: modified.path,
          errorName: error instanceof Error ? error.name : 'UnknownError'
        })
        setLoadState('error')
      })

    return () => {
      active = false
      stopThemeObserver()
      stopTypographyObserver()
      saveStateRef.current?.(diffEditor?.saveViewState() ?? null)
      for (const listener of scrollListeners) listener.dispose()
      editorRef.current = null
      diffEditor?.setModel(null)
      diffEditor?.dispose()
      const releaseModels = (): void => {
        originalModel?.dispose()
        modifiedModel?.dispose()
      }
      window.setTimeout(releaseModels, 0)
    }
  }, [modified.content, modified.path, original.content, original.path, t])

  useEffect(() => {
    editorRef.current?.updateOptions({
      renderSideBySide: viewMode === 'side-by-side',
      diffWordWrap: wrapLines ? 'on' : 'off',
      hideUnchangedRegions: collapseUnchanged
        ? {
            enabled: true,
            revealLineCount: 3,
            minimumLineCount: 6,
            contextLineCount: 3
          }
        : { enabled: false }
    })
    if (viewMode === 'side-by-side') {
      // Monaco 隐藏原始侧时设为 off，恢复左右模式后需解除该高优先级覆盖。
      editorRef.current?.getOriginalEditor().updateOptions({ wordWrapOverride2: 'inherit' })
    }
  }, [collapseUnchanged, viewMode, wrapLines])

  return (
    <div
      data-testid="code-diff"
      className="relative flex h-full min-h-0 w-full flex-col overflow-hidden bg-background"
    >
      <div ref={hostRef} className="min-h-0 flex-1" />
      <div
        role="status"
        aria-label={t('diffStatus')}
        className="flex min-h-6 shrink-0 items-center justify-end border-t px-3 text-xs text-muted-foreground"
      >
        {changeCount === null ? t('diffCalculating') : t('diffCount', { count: changeCount })}
      </div>
      {loadState === 'loading' ? (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center gap-2 bg-background text-sm text-muted-foreground">
          <LoaderCircleIcon className="size-4 animate-spin" /> {t('diffLoading')}
        </div>
      ) : null}
      {loadState === 'error' ? (
        <div className="absolute inset-0 flex items-center justify-center p-6 text-center text-sm text-destructive">
          {t('diffFailed')}
        </div>
      ) : null}
    </div>
  )
}

export const L4CodeDiff = forwardRef(L4CodeDiffComponent)
