import 'server-only'

/** 只保护安装目录的读写；扩展工厂和生命周期不能持有此锁。 */
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
