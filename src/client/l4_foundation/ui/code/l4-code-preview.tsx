'use client'

import { LoaderCircleIcon } from 'lucide-react'
import {
  forwardRef,
  useCallback,
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
import { bindL4CodeLineMarkers, type L4CodeLineMarkers } from './l4-code-line-markers'
import markerStyles from './l4-code-line-markers.module.css'

export type L4CodePreviewState = editor.ICodeEditorViewState

export interface L4CodeLineNavigation {
  readonly line: number
}

export interface L4CodePreviewHandle {
  openSearch: () => void
  gotoLine: () => void
  getSelectionText: () => string
  getViewState: () => L4CodePreviewState | null
  focus: () => void
  previousChange: () => void
  nextChange: () => void
}

interface L4CodePreviewProps {
  path: string
  content: string
  size: number
  savedState: L4CodePreviewState | null
  onSaveState: (path: string, state: L4CodePreviewState | null) => void
  onEscape?: () => void
  originalContent?: string
  onChanges?: (count: number | null) => void
  onOpenDiff?: (lineNumber: number) => void
  navigation?: L4CodeLineNavigation | null
  onNavigation?: (target: L4CodeLineNavigation, exists: boolean) => void
}

function L4CodePreviewComponent(
  {
    path,
    content,
    size,
    savedState,
    onSaveState,
    onEscape,
    originalContent,
    onChanges,
    onOpenDiff,
    navigation,
    onNavigation
  }: L4CodePreviewProps,
  ref: ForwardedRef<L4CodePreviewHandle>
): React.JSX.Element {
  const { t } = useTranslation('common')
  const { t: projectFilesT } = useTranslation('projectFiles')
  const { wrapLines } = useL4CodePreferences()
  const hostRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null)
  const onSaveStateRef = useRef(onSaveState)
  const wrapLinesRef = useRef(wrapLines)
  const savedStateRef = useRef(savedState)
  const escapeRef = useRef(onEscape)
  const markersRef = useRef<L4CodeLineMarkers | null>(null)
  const changesRef = useRef(onChanges)
  const openDiffRef = useRef(onOpenDiff)
  const navigationCompleteRef = useRef(onNavigation)
  const navigationMarkersRef = useRef<editor.IEditorDecorationsCollection | null>(null)
  const highlightedLineRef = useRef<number | null>(null)
  const paintNavigation = useCallback((codeEditor: editor.IStandaloneCodeEditor): void => {
    const line = highlightedLineRef.current
    navigationMarkersRef.current?.clear()
    if (line === null || line > (codeEditor.getModel()?.getLineCount() ?? 0)) return
    navigationMarkersRef.current ??= codeEditor.createDecorationsCollection()
    navigationMarkersRef.current.set([
      {
        range: { startLineNumber: line, startColumn: 1, endLineNumber: line, endColumn: 1 },
        options: { isWholeLine: true, className: 'bg-accent' }
      }
    ])
  }, [])

  useEffect(() => {
    savedStateRef.current = savedState
    escapeRef.current = onEscape
    changesRef.current = onChanges
    openDiffRef.current = onOpenDiff
    navigationCompleteRef.current = onNavigation
  }, [onChanges, onEscape, onOpenDiff, onNavigation, savedState])
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading')

  useEffect(() => {
    onSaveStateRef.current = onSaveState
  }, [onSaveState])

  useEffect(() => {
    wrapLinesRef.current = wrapLines
  }, [wrapLines])

  useImperativeHandle(
    ref,
    () => ({
      openSearch(): void {
        void editorRef.current?.getAction('actions.find')?.run()
      },
      gotoLine(): void {
        void editorRef.current?.getAction('editor.action.gotoLine')?.run()
      },
      getSelectionText(): string {
        const codeEditor = editorRef.current
        const model = codeEditor?.getModel()
        const selection = codeEditor?.getSelection()
        return model && selection && !selection.isEmpty() ? model.getValueInRange(selection) : ''
      },
      getViewState(): L4CodePreviewState | null {
        return editorRef.current?.saveViewState() ?? null
      },
      focus(): void {
        editorRef.current?.focus()
      },
      previousChange(): void {
        markersRef.current?.previousChange()
      },
      nextChange(): void {
        markersRef.current?.nextChange()
      }
    }),
    []
  )

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    let active = true
    let codeEditor: editor.IStandaloneCodeEditor | null = null
    let model: editor.ITextModel | null = null
    let markers: L4CodeLineMarkers | null = null
    let stopThemeObserver = (): void => undefined
    let stopTypographyObserver = (): void => undefined

    queueMicrotask(() => {
      if (active) setLoadState('loading')
    })
    void loadL4Monaco()
      .then((monaco) => {
        if (!active) return
        model = monaco.editor.createModel(
          content,
          getL4MonacoLanguage(path, size),
          createL4MonacoModelUri(monaco, path, 'preview')
        )
        codeEditor = monaco.editor.create(host, {
          model,
          theme: getL4MonacoTheme(),
          readOnly: true,
          domReadOnly: true,
          // EditContext 不遵循 domReadOnly，预览使用原生只读输入框避免唤起软键盘。
          editContext: false,
          automaticLayout: true,
          minimap: { enabled: false },
          stickyScroll: { enabled: false },
          scrollBeyondLastLine: false,
          // 只读预览避免把每格滚轮输入扩展为多帧重绘。
          smoothScrolling: false,
          wordWrap: wrapLinesRef.current ? 'on' : 'off',
          wrappingIndent: 'same',
          ...getL4MonacoTypography(),
          lineNumbersMinChars: 3,
          lineDecorationsWidth: 26,
          folding: size <= 1024 * 1024,
          renderValidationDecorations: 'off',
          renderWhitespace: 'selection',
          bracketPairColorization: { enabled: size <= 1024 * 1024 },
          unicodeHighlight: { nonBasicASCII: false },
          padding: { top: 10, bottom: 10 },
          overviewRulerBorder: false,
          contextmenu: true,
          ariaLabel: t('codeReadOnly')
        })
        if (savedStateRef.current) codeEditor.restoreViewState(savedStateRef.current)
        if (escapeRef.current)
          bindL4MonacoPreviewEscape(codeEditor, monaco.KeyCode.Escape, () => escapeRef.current?.())
        editorRef.current = codeEditor
        if (originalContent !== undefined) {
          markers = bindL4CodeLineMarkers(codeEditor, monaco, {
            path,
            original: originalContent,
            modified: content,
            tooltip: (kind, count) =>
              projectFilesT(
                {
                  added: 'gitAddedLines',
                  modified: 'gitModifiedLines',
                  deleted: 'gitDeletedLines'
                }[kind],
                { count }
              ),
            onChanges: (count) => changesRef.current?.(count),
            onOpenDiff: (lineNumber) => openDiffRef.current?.(lineNumber)
          })
          markersRef.current = markers
        }
        stopThemeObserver = observeL4MonacoTheme((theme) => monaco.editor.setTheme(theme))
        stopTypographyObserver = observeL4MonacoTypography((typography) =>
          codeEditor?.updateOptions(typography)
        )
        paintNavigation(codeEditor)
        setLoadState('ready')
      })
      .catch((error: unknown) => {
        if (!active) return
        console.error('[Pi Desk][CodePreview] Monaco 加载失败', {
          path,
          errorName: error instanceof Error ? error.name : 'UnknownError'
        })
        setLoadState('error')
        if (originalContent !== undefined) changesRef.current?.(null)
      })

    return () => {
      active = false
      stopThemeObserver()
      stopTypographyObserver()
      markers?.dispose()
      markersRef.current = null
      if (codeEditor) {
        savedStateRef.current = codeEditor.saveViewState()
        onSaveStateRef.current(path, savedStateRef.current)
      }
      navigationMarkersRef.current?.clear()
      navigationMarkersRef.current = null
      editorRef.current = null
      codeEditor?.dispose()
      model?.dispose()
    }
  }, [content, originalContent, paintNavigation, path, projectFilesT, size, t])

  useEffect(() => {
    editorRef.current?.updateOptions({ wordWrap: wrapLines ? 'on' : 'off' })
  }, [wrapLines])

  useEffect(() => {
    const codeEditor = editorRef.current
    if (!navigation || loadState !== 'ready' || !codeEditor) return
    const model = codeEditor.getModel()
    const exists = Boolean(model && navigation.line >= 1 && navigation.line <= model.getLineCount())
    highlightedLineRef.current = exists ? navigation.line : null
    paintNavigation(codeEditor)
    if (exists) {
      codeEditor.setPosition({ lineNumber: navigation.line, column: 1 })
      codeEditor.revealLineInCenter(navigation.line)
      savedStateRef.current = codeEditor.saveViewState()
      onSaveStateRef.current(path, savedStateRef.current)
    }
    navigationCompleteRef.current?.(navigation, exists)
  }, [loadState, navigation, paintNavigation, path])

  return (
    <div
      data-testid="code-preview"
      className="relative h-full min-h-0 w-full overflow-hidden bg-background"
    >
      <div ref={hostRef} className={`size-full ${markerStyles.host}`} />
      {loadState === 'loading' ? (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center gap-2 bg-background text-sm text-muted-foreground">
          <LoaderCircleIcon className="size-4 animate-spin" /> {t('codeLoading')}
        </div>
      ) : null}
      {loadState === 'error' ? (
        <div className="absolute inset-0 flex items-center justify-center p-6 text-center text-sm text-destructive">
          {t('codeFailed')}
        </div>
      ) : null}
    </div>
  )
}

export const L4CodePreview = forwardRef(L4CodePreviewComponent)
