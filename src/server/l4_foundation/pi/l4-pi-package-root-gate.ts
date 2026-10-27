import 'server-only'

/** 只串行安装目录写入；只读发现、聊天与扩展生命周期不得等待此锁。 */
export function runL4PiPackageRootExclusive<T>(operation: () => Promise<T>): Promise<T> {
  const previous = globalThis.__piDeskPackageRootTail ?? Promise.resolve()
  const result = previous.then(operation, operation)
  globalThis.__piDeskPackageRootTail = result.then(
    () => undefined,
    () => undefined
  )
  return result
}

declare global {
  var __piDeskPackageRootTail: Promise<void> | undefined
}
