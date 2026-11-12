import * as fs from 'node:fs/promises'

// 包要求 Node >=22.19；当前工程的 @types/node 20 尚未声明原生 glob。
const native = fs as typeof fs & { glob(pattern: string): AsyncIterable<string> }

export async function* globL4Environment(pattern: string): AsyncGenerator<string> {
  yield* native.glob(pattern)
}
