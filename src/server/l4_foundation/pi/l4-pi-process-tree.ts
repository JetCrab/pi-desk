import 'server-only'

import type { ChildProcess } from 'node:child_process'
import { join } from 'node:path'

// CLI 本身不能加载 server-only；通过此适配入口复用原生 Node 进程能力。
// 从 Node 运行时获取 createRequire，避免 Webpack 静态改写动态路径。
// 与探针 runner 一样，以应用启动时固定的 package cwd 解析，不走 Next chunk 相对路径。
const { createRequire } = process.getBuiltinModule('module')
const loadRuntime = createRequire(join(process.cwd(), 'package.json'))
const runtime = loadRuntime('./src/server/l4_foundation/process/l4-process-tree.js') as {
  terminateManagedTree(child: ChildProcess): Promise<void>
}

export function terminateL4PiProcessTree(child: ChildProcess): Promise<void> {
  return runtime.terminateManagedTree(child)
}
