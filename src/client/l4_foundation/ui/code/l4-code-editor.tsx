'use client'

import { useEffect, useRef, useState } from 'react'
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
import { readL4CodePreferences, useL4CodePreferences } from './l4-code-preferences'

interface L4CodeEditorProps {
  path: string
  content: string
  size: number
  readOnly: boolean
  onChange: (content: string) => void
  onSave: () => void
}

export function L4CodeEditor(props: L4CodeEditorProps): React.JSX.Element {
  const { t } = useTranslation('common')
  const { wrapLines } = useL4CodePreferences()
  const path = props.path
  const hostRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null)
  const modelRef = useRef<editor.ITextModel | null>(null)
  const modelChangeRef = useRef<{ dispose: () => void } | null>(null)
  const modelPathRef = useRef<string | null>(null)
  const modelRequestSequence = useRef(0)
  const latest = useRef(props)
  const [error, setError] = useState(false)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    latest.current = props
  })

  useEffect(() => {
    let disposed = false
    let stopTheme = (): void => undefined
    let stopTypography = (): void => undefined
    void loadL4Monaco()
      .then((monaco) => {
        if (disposed || !hostRef.current) return
        const current = latest.current
        const instance = monaco.editor.create(hostRef.current, {
          model: null,
          theme: getL4MonacoTheme(),
          automaticLayout: true,
          readOnly: current.readOnly,
          domReadOnly: current.readOnly,
          wordWrap: readL4CodePreferences().wrapLines ? 'on' : 'off',
          wrappingIndent: 'same',
          minimap: { enabled: false },
          stickyScroll: { enabled: false },
          scrollBeyondLastLine: false,
          ...getL4MonacoTypography(),
          lineNumbersMinChars: 3,
          padding: { top: 14, bottom: 14 },
          unicodeHighlight: { nonBasicASCII: false },
          renderWhitespace: 'selection',
          overviewRulerBorder: false,
          ariaLabel: t('skillEditor')
        })
        editorRef.current = instance
        instance.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () =>
          latest.current.onSave()
        )
        stopTheme = observeL4MonacoTheme((theme) => monaco.editor.setTheme(theme))
        stopTypography = observeL4MonacoTypography((typography) =>
          instance.updateOptions(typography)
        )
        setReady(true)
      })
      .catch(() => {
        if (!disposed) setError(true)
      })
    return () => {
      disposed = true
      stopTheme()
      stopTypography()
      modelChangeRef.current?.dispose()
      modelChangeRef.current = null
      modelRef.current?.dispose()
      modelRef.current = null
      modelPathRef.current = null
      editorRef.current?.dispose()
      editorRef.current = null
    }
  }, [t])

  useEffect(() => {
    let disposed = false
    const requestId = modelRequestSequence.current + 1
    modelRequestSequence.current = requestId
    void loadL4Monaco().then((monaco) => {
      if (disposed || requestId !== modelRequestSequence.current || !editorRef.current) return
      const current = latest.current
      const next = monaco.editor.createModel(
        current.content,
        getL4MonacoLanguage(current.path, current.size),
        createL4MonacoModelUri(monaco, current.path, 'edit')
      )
      const previous = modelRef.current
      modelChangeRef.current?.dispose()
      modelChangeRef.current = next.onDidChangeContent(() => {
        latest.current.onChange(next.getValue(monaco.editor.EndOfLinePreference.LF))
      })
      modelRef.current = next
      modelPathRef.current = path
      editorRef.current.setModel(next)
      previous?.dispose()
    })
    return () => {
      disposed = true
    }
  }, [path])

  useEffect(() => {
    const model = modelRef.current
    if (
      model &&
      modelPathRef.current === props.path &&
      model.getValue().replace(/\r\n|\r/g, '\n') !== props.content
    ) {
      model.setValue(props.content)
    }
  }, [props.content, props.path])

  useEffect(() => {
    editorRef.current?.updateOptions({
      readOnly: props.readOnly,
      domReadOnly: props.readOnly,
      wordWrap: wrapLines ? 'on' : 'off'
    })
  }, [props.readOnly, wrapLines])

  return (
    <div
      data-testid="code-editor"
      className="relative h-full min-h-0 w-full overflow-hidden bg-background"
    >
      <div ref={hostRef} className="size-full" />
      {!ready && (
        <div
          role="status"
          className="absolute inset-0 flex items-center justify-center p-6 text-sm text-muted-foreground"
        >
          {error ? t('editorFailed') : t('editorLoading')}
        </div>
      )}
    </div>
  )
}
