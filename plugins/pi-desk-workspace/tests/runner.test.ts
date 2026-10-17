import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { afterEach, test } from 'node:test'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { COMMAND_INPUT_SCHEMA, COMMAND_RESULT_SCHEMA } from '../src/core.js'

const execFileAsync = promisify(execFile)
const tempRoot = resolve(process.cwd(), '../../temp/pi/workspace/test-runner')
const runnerPath = resolve(fileURLToPath(new URL('../src/command-runner.mjs', import.meta.url)))
afterEach(async () => rm(tempRoot, { recursive: true, force: true }))

async function runHandler(source: string): Promise<{
  output: Record<string, unknown>
  log: string
  failed: boolean
}> {
  await mkdir(tempRoot, { recursive: true })
  const handlerPath = join(tempRoot, 'handler.mjs')
  const inputPath = join(tempRoot, 'input.json')
  const outputPath = join(tempRoot, 'output.json')
  const logPath = join(tempRoot, 'command.log')
  await mkdir(join(tempRoot, 'workspace-root'), { recursive: true })
  await writeFile(handlerPath, source, 'utf8')
  await writeFile(
    inputPath,
    JSON.stringify({
      schema: COMMAND_INPUT_SCHEMA,
      command: 'test',
      project: { root: tempRoot },
      workspace: {
        id: 'ws-123456789abc',
        root: join(tempRoot, 'workspace-root'),
        definition: 'demo',
        provisionParameters: {}
      },
      occupation: {
        id: 'as-1234567890abcdef',
        requirement: 'Runner test',
        occupiedAt: Date.now()
      },
      parameters: {}
    }),
    'utf8'
  )
  await writeFile(logPath, 'runner test\n', 'utf8')

  let failed = false
  try {
    await execFileAsync(
      process.execPath,
      [runnerPath, handlerPath, inputPath, outputPath, logPath],
      {
        cwd: tempRoot
      }
    )
  } catch {
    failed = true
  }
  return {
    output: JSON.parse(await readFile(outputPath, 'utf8')) as Record<string, unknown>,
    log: await readFile(logPath, 'utf8'),
    failed
  }
}

test('Runner 加载默认 Handler、执行无 shell 子命令并写明确成功结果', async () => {
  const result = await runHandler(`
export default async function run(input, context) {
  context.log('requirement=' + input.occupation.requirement)
  const child = await context.exec(process.execPath, ['-e', 'process.stdout.write(process.cwd())'])
  context.log('child-cwd=' + child.stdout)
  return { success: true, summary: 'runner completed' }
}
`)
  assert.equal(result.failed, false)
  assert.deepEqual(result.output, {
    schema: COMMAND_RESULT_SCHEMA,
    success: true,
    summary: 'runner completed'
  })
  assert.match(result.log, /requirement=Runner test/)
  assert.match(result.log, /child-cwd=.*workspace-root/)
})

test('Runner 保留跨 chunk 的 UTF-8 stdout 和 stderr', async () => {
  const child = `
import { watch, readFileSync } from 'node:fs'
const flag = process.argv[2]
const watcher = watch(flag, () => {
  if (readFileSync(flag, 'utf8') !== 'finish') return
  watcher.close()
  process.stdout.write(Buffer.from([0xb8, 0xad, 0xe6, 0x96, 0x87]))
  process.stderr.write(Buffer.from([0x98, 0x80]))
})
process.stdout.write(Buffer.concat([Buffer.from('stdout-first:'), Buffer.from([0xe4])]))
process.stderr.write(Buffer.concat([Buffer.from('stderr-first:'), Buffer.from([0xf0, 0x9f])]))
`
  const result = await runHandler(`
import { watch } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
export default async function run(input, context) {
  const child = join(input.project.root, 'split-output.mjs')
  const flag = join(input.project.root, 'continue.txt')
  const log = join(input.project.root, 'command.log')
  await writeFile(child, ${JSON.stringify(child)})
  await writeFile(flag, '')
  let watcher
  let timer
  const ready = new Promise((resolveReady, rejectReady) => {
    const check = async () => {
      const bytes = await readFile(log)
      const stdout = Buffer.concat([Buffer.from('stdout-first:'), Buffer.from([0xe4])])
      const stderr = Buffer.concat([Buffer.from('stderr-first:'), Buffer.from([0xf0, 0x9f])])
      if (bytes.includes(stdout) && bytes.includes(stderr)) resolveReady()
    }
    watcher = watch(log, () => { void check().catch(rejectReady) })
    timer = setTimeout(() => rejectReady(new Error('分块输出未就绪')), 5000)
  })
  try {
    const execution = context.exec(process.execPath, [child, flag])
    await ready
    await writeFile(flag, 'finish')
    const { stdout, stderr } = await execution
    return { success: true, summary: JSON.stringify({ stdout, stderr }) }
  } finally {
    clearTimeout(timer)
    watcher.close()
  }
}
`)
  assert.equal(result.failed, false)
  assert.deepEqual(JSON.parse(String(result.output.summary)), {
    stdout: 'stdout-first:中文',
    stderr: 'stderr-first:😀'
  })
})

test('Runner 输出截尾不会保留半个 UTF-8 字符或超过缓冲上限', async () => {
  const child = `
const output = Buffer.concat([Buffer.from('中'), Buffer.alloc(1024 * 1024 - 1, 0x61)])
process.stdout.write(output)
process.stderr.write(output)
`
  const result = await runHandler(`
export default async function run(input, context) {
  const { stdout, stderr } = await context.exec(process.execPath, ['-e', ${JSON.stringify(child)}])
  return {
    success: true,
    summary: JSON.stringify({
      stdoutBytes: Buffer.byteLength(stdout),
      stderrBytes: Buffer.byteLength(stderr),
      stdoutIntact: stdout === 'a'.repeat(1024 * 1024 - 1),
      stderrIntact: stderr === 'a'.repeat(1024 * 1024 - 1)
    })
  }
}
`)
  assert.equal(result.failed, false)
  assert.deepEqual(JSON.parse(String(result.output.summary)), {
    stdoutBytes: 1024 * 1024 - 1,
    stderrBytes: 1024 * 1024 - 1,
    stdoutIntact: true,
    stderrIntact: true
  })
})

test('Handler 抛错时 Runner 写失败结果并使用非零退出码', async () => {
  const result = await runHandler(`
export default async function run() {
  throw new Error('handler exploded')
}
`)
  assert.equal(result.failed, true)
  assert.deepEqual(result.output, {
    schema: COMMAND_RESULT_SCHEMA,
    success: false,
    error: 'handler exploded'
  })
  assert.match(result.log, /runner failed: handler exploded/)
})
