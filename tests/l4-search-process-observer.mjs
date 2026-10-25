import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { resolve } from 'node:path'

// 由搜索 E2E 的 NODE_OPTIONS 加载，只观测隔离 fixture 的真实子进程。
const cwd = process.env.PI_DESK_SEARCH_TEST_CWD
if (cwd) {
  const original = childProcess.spawn
  childProcess.spawn = function (command, args, options) {
    const child = original.call(this, command, args, options)
    if (
      /[/\\]rg(?:\.exe)?$/i.test(String(command)) &&
      options?.cwd &&
      resolve(options.cwd) === resolve(cwd)
    ) {
      child.once('spawn', () =>
        process.send?.({ type: 'search-test-rg', phase: 'spawn', pid: child.pid })
      )
      child.once('close', (code, signal) =>
        process.send?.({ type: 'search-test-rg', phase: 'close', pid: child.pid, code, signal })
      )
    }
    return child
  }
  syncBuiltinESMExports()
}
