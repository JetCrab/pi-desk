import type { editor } from 'monaco-editor'
import type { L4Monaco } from './l4-monaco-runtime'
import type { L4LineChange } from './l4-code-line-changes'
import styles from './l4-code-line-markers.module.css'

export interface L4CodeLineMarkers {
  previousChange: () => void
  nextChange: () => void
  dispose: () => void
}

export function bindL4CodeLineMarkers(
  codeEditor: editor.IStandaloneCodeEditor,
  monaco: L4Monaco,
  input: {
    path: string
    original: string
    modified: string
    tooltip: (kind: L4LineChange['kind'], count: number) => string
    onChanges: (count: number | null) => void
    onOpenDiff: (lineNumber: number) => void
  }
): L4CodeLineMarkers {
  const decorations = codeEditor.createDecorationsCollection()
  const lineCount = codeEditor.getModel()?.getLineCount() ?? 1
  let changes: L4LineChange[] = []
  let active = true
  let worker: Worker | null = null
  let timeout: ReturnType<typeof setTimeout> | null = null
  const markerSelector = [styles.added, styles.modified, styles.deletedBefore, styles.deletedAfter]
    .map((className) => `.${className}`)
    .join(',')

  const markerLine = (change: L4LineChange): number =>
    Math.min(
      lineCount,
      change.kind === 'deleted'
        ? Math.max(1, change.modifiedStartLineNumber - 1)
        : change.modifiedStartLineNumber
    )

  const stopWorker = (): void => {
    if (timeout !== null) clearTimeout(timeout)
    timeout = null
    worker?.terminate()
    worker = null
  }

  const finish = (result: L4LineChange[] | null): void => {
    if (!active) return
    stopWorker()
    changes = result ?? []
    decorations.set(
      changes.map((change): editor.IModelDeltaDecoration => {
        const deleted = change.kind === 'deleted'
        const startLine = markerLine(change)
        const endLine = deleted ? startLine : change.modifiedEndLineNumberExclusive - 1
        const count = deleted
          ? change.originalEndLineNumberExclusive - change.originalStartLineNumber
          : change.modifiedEndLineNumberExclusive - change.modifiedStartLineNumber
        const colors = {
          added: ['#16803c', '#59c77b'],
          modified: ['#216bcc', '#6aabff'],
          deleted: ['#d12c38', '#ff757f']
        }[change.kind]
        const markerClass = deleted
          ? change.modifiedStartLineNumber === 1
            ? styles.deletedBefore
            : styles.deletedAfter
          : styles[change.kind]
        return {
          range: new monaco.Range(startLine, 1, endLine, 1),
          options: {
            isWholeLine: !deleted,
            showIfCollapsed: true,
            linesDecorationsClassName: deleted ? undefined : markerClass,
            firstLineDecorationClassName: deleted ? markerClass : undefined,
            linesDecorationsTooltip: input.tooltip(change.kind, count),
            overviewRuler: {
              color: colors[0],
              darkColor: colors[1],
              position: monaco.editor.OverviewRulerLane.Left
            }
          }
        }
      })
    )
    if (result === null) {
      console.warn('[Pi Desk][CodePreview] 行标记不可用，计算失败或超过限制', {
        path: input.path
      })
    }
    input.onChanges(result?.length ?? null)
  }

  const mouseListener = codeEditor.onMouseDown((event) => {
    if (
      event.target.type !== monaco.editor.MouseTargetType.GUTTER_LINE_DECORATIONS ||
      !event.target.element?.closest(markerSelector)
    ) {
      return
    }
    const line = event.target.position?.lineNumber
    if (line === undefined) return
    const change = changes.find((item) =>
      item.kind === 'deleted'
        ? markerLine(item) === line
        : item.modifiedStartLineNumber <= line && line < item.modifiedEndLineNumberExclusive
    )
    if (change) input.onOpenDiff(line)
  })

  try {
    worker = new Worker(new URL('./l4-code-line-changes.worker.ts', import.meta.url), {
      type: 'module',
      name: 'pi-desk-line-changes'
    })
    worker.onmessage = (event: MessageEvent<L4LineChange[] | null>): void => finish(event.data)
    worker.onerror = (): void => finish(null)
    worker.onmessageerror = (): void => finish(null)
    // 含 Worker 启动预算；取消时终止 Worker，旧文件结果没有回流通道。
    timeout = setTimeout(() => finish(null), 3_000)
    worker.postMessage({ original: input.original, modified: input.modified })
  } catch {
    finish(null)
  }

  const navigate = (direction: 'previous' | 'next'): void => {
    if (changes.length === 0) return
    const currentLine = codeEditor.getPosition()?.lineNumber ?? 1
    const lines = changes.map(markerLine)
    const line =
      direction === 'next'
        ? (lines.find((item) => item > currentLine) ?? lines[0])
        : (lines.findLast((item) => item < currentLine) ?? lines[lines.length - 1])
    codeEditor.setPosition({ lineNumber: line, column: 1 })
    codeEditor.revealLineInCenter(line)
    codeEditor.focus()
  }

  return {
    previousChange(): void {
      navigate('previous')
    },
    nextChange(): void {
      navigate('next')
    },
    dispose(): void {
      active = false
      stopWorker()
      mouseListener.dispose()
      decorations.clear()
      changes = []
    }
  }
}
