declare module 'monaco-editor/editor/common/diff/defaultLinesDiffComputer/defaultLinesDiffComputer' {
  interface LineRange {
    startLineNumber: number
    endLineNumberExclusive: number
  }

  export class DefaultLinesDiffComputer {
    computeDiff(
      originalLines: string[],
      modifiedLines: string[],
      options: {
        ignoreTrimWhitespace: boolean
        maxComputationTimeMs: number
        computeMoves: boolean
      }
    ): {
      changes: { original: LineRange; modified: LineRange }[]
      hitTimeout: boolean
    }
  }
}
