import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import crossSpawn from 'cross-spawn'

const RESULT_SCHEMA = 'pi.workspace-command-result/v1'
const MAX_BUFFER_BYTES = 1024 * 1024

const [handlerPath, inputPath, outputPath, logPath] = process.argv.slice(2)
if (!handlerPath || !inputPath || !outputPath || !logPath) {
  process.stderr.write('Workspace command runner arguments are incomplete.\n')
  process.exit(1)
}

const originalConsole = {
  log: console.log.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console)
}

function formatValue(value) {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function appendLog(message) {
  appendFileSync(logPath, `[${new Date().toISOString()}] ${message}\n`, 'utf8')
}

console.log = (...values) => {
  const message = values.map(formatValue).join(' ')
  appendLog(message)
  originalConsole.log(...values)
}
console.warn = (...values) => {
  const message = values.map(formatValue).join(' ')
  appendLog(`WARN ${message}`)
  originalConsole.warn(...values)
}
console.error = (...values) => {
  const message = values.map(formatValue).join(' ')
  appendLog(`ERROR ${message}`)
  originalConsole.error(...values)
}

function tailBuffer(current, chunk) {
  const next = Buffer.concat([current, chunk])
  let start = Math.max(0, next.length - MAX_BUFFER_BYTES)
  // 截断点落在字符内部时，只丢弃该字符剩余的 UTF-8 续字节。
  while (start > 0 && start < next.length && (next[start] & 0xc0) === 0x80) start += 1
  return next.subarray(start)
}

function writeResult(result) {
  writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8')
}

const controller = new AbortController()
const children = new Set()

function abort() {
  if (controller.signal.aborted) return
  controller.abort()
  for (const child of children) {
    try {
      child.kill()
    } catch {
      // Parent process termination remains the final process-tree fallback.
    }
  }
}

process.once('SIGINT', abort)
process.once('SIGTERM', abort)

function execute(program, args, options = {}) {
  if (typeof program !== 'string' || !program.trim()) {
    return Promise.reject(new Error('program 必须是非空字符串'))
  }
  if (!Array.isArray(args) || !args.every((item) => typeof item === 'string')) {
    return Promise.reject(new Error('args 必须是字符串数组'))
  }
  if (controller.signal.aborted) return Promise.reject(new Error('命令已中断'))

  const cwd = options.cwd ?? input.workspace.root
  appendLog(`exec ${program} ${JSON.stringify(args)} cwd=${cwd}`)

  return new Promise((resolve, reject) => {
    const child = crossSpawn(program, args, {
      cwd,
      env: process.env,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    children.add(child)

    let stdout = Buffer.alloc(0)
    let stderr = Buffer.alloc(0)
    let settled = false

    const onAbort = () => {
      try {
        child.kill()
      } catch {
        // Parent process termination remains the final process-tree fallback.
      }
    }
    controller.signal.addEventListener('abort', onAbort, { once: true })

    child.stdout?.on('data', (chunk) => {
      stdout = tailBuffer(stdout, chunk)
      appendFileSync(logPath, chunk)
    })
    child.stderr?.on('data', (chunk) => {
      stderr = tailBuffer(stderr, chunk)
      appendFileSync(logPath, chunk)
    })

    child.once('error', (error) => {
      if (settled) return
      settled = true
      children.delete(child)
      controller.signal.removeEventListener('abort', onAbort)
      reject(error)
    })

    child.once('close', (code) => {
      if (settled) return
      settled = true
      children.delete(child)
      controller.signal.removeEventListener('abort', onAbort)
      if (controller.signal.aborted) {
        reject(new Error('命令已中断'))
        return
      }
      if (code !== 0) {
        reject(new Error(`${program} 执行失败，退出码 ${String(code)}`))
        return
      }
      resolve({ stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8'), code: code ?? 0 })
    })
  })
}

let input
try {
  input = JSON.parse(readFileSync(inputPath, 'utf8'))
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('命令输入必须是对象')
  }

  appendLog(`handler ${handlerPath}`)
  const handlerModule = await import(pathToFileURL(handlerPath).href)
  if (typeof handlerModule.default !== 'function') {
    throw new Error('Workspace Handler 必须默认导出函数')
  }

  const result = await handlerModule.default(input, {
    signal: controller.signal,
    log(message) {
      appendLog(String(message))
    },
    exec: execute
  })

  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new Error('Workspace Handler 必须返回结果对象')
  }
  if (result.success !== true && result.success !== false) {
    throw new Error('Workspace Handler 必须明确返回 success: true 或 false')
  }

  if (result.success === true) {
    if (result.error !== undefined) throw new Error('成功结果不能包含 error')
    if (result.summary !== undefined && typeof result.summary !== 'string') {
      throw new Error('summary 必须是字符串')
    }
    writeResult({
      schema: RESULT_SCHEMA,
      success: true,
      ...(result.summary ? { summary: result.summary } : {})
    })
    appendLog('handler completed successfully')
  } else {
    if (typeof result.error !== 'string' || !result.error.trim()) {
      throw new Error('失败结果必须包含非空 error')
    }
    writeResult({ schema: RESULT_SCHEMA, success: false, error: result.error })
    appendLog(`handler reported failure: ${result.error}`)
    process.exitCode = 1
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  appendLog(`runner failed: ${message}`)
  try {
    writeResult({ schema: RESULT_SCHEMA, success: false, error: message })
  } catch (writeError) {
    originalConsole.error(writeError)
  }
  originalConsole.error(error)
  process.exitCode = 1
} finally {
  abort()
}
