import { DefaultLinesDiffComputer } from 'monaco-editor/editor/common/diff/defaultLinesDiffComputer/defaultLinesDiffComputer'

export interface L4LineChange {
  kind: 'added' | 'modified' | 'deleted'
  originalStartLineNumber: number
  originalEndLineNumberExclusive: number
  modifiedStartLineNumber: number
  modifiedEndLineNumberExclusive: number
}

/** 行号从 1 开始，结束行不包含在范围内；纯删除的 modified 范围为空。 */
export function computeL4LineChanges(original: string, modified: string): L4LineChange[] | null {
  if (original.length + modified.length > 2 * 1024 * 1024) return null
  const originalLines = original.split(/\r\n|\r|\n/)
  const modifiedLines = modified.split(/\r\n|\r|\n/)
  if (originalLines.length + modifiedLines.length > 50_000) return null

  try {
    const startedAt = Date.now()
    const result = new DefaultLinesDiffComputer().computeDiff(originalLines, modifiedLines, {
      ignoreTrimWhitespace: false,
      maxComputationTimeMs: 500,
      computeMoves: false
    })
    if (result.hitTimeout || Date.now() - startedAt > 500) return null
    return result.changes.map(({ original: before, modified: after }) => {
      // Monaco 的空模型占一行，但空文件不应被归类为替换了这一行。
      const originalEnd = original === '' ? 1 : before.endLineNumberExclusive
      const modifiedEnd = modified === '' ? 1 : after.endLineNumberExclusive
      return {
        kind:
          before.startLineNumber === originalEnd
            ? 'added'
            : after.startLineNumber === modifiedEnd
              ? 'deleted'
              : 'modified',
        originalStartLineNumber: before.startLineNumber,
        originalEndLineNumberExclusive: originalEnd,
        modifiedStartLineNumber: after.startLineNumber,
        modifiedEndLineNumberExclusive: modifiedEnd
      }
    })
  } catch (error: unknown) {
    console.warn('[Pi Desk][CodePreview] 行差异计算失败', {
      errorName: error instanceof Error ? error.name : 'UnknownError'
    })
    return null
  }
}
