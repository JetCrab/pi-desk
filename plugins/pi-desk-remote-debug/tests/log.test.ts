import assert from 'node:assert/strict'
import { mkdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { MAX_RUN_LOG_BYTES, pruneRunArtifacts, RunLogger } from '../src/log.js'

const root = resolve('temp', 'pi', 'remote-debug-log-test', String(process.pid))

test.after(async () => {
  await rm(root, { recursive: true, force: true })
})

test('单次日志达到 20MB 后写入截断标记但不抛出', async () => {
  const path = join(root, 'bounded', 'run.log')
  const logger = await RunLogger.create(path, 'fixture')

  logger.line('command', 'x'.repeat(MAX_RUN_LOG_BYTES + 1024))
  logger.line('command', 'ignored-after-limit')
  await logger.close()

  const metadata = await stat(path)
  const content = await readFile(path, 'utf8')
  assert.ok(metadata.size <= MAX_RUN_LOG_BYTES)
  assert.match(content, /日志达到 20MB 上限/)
  assert.equal(content.includes('ignored-after-limit'), false)
})

test('清理旧目录时保留活动 Run 并删除最早非活动目录', async () => {
  const artifacts = join(root, 'artifacts')
  const first = join(artifacts, 'first')
  const second = join(artifacts, 'second')
  const third = join(artifacts, 'third')
  for (const directory of [first, second, third]) {
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'run.log'), directory, 'utf8')
  }
  await utimes(join(first, 'run.log'), new Date(1000), new Date(1000))
  await utimes(join(second, 'run.log'), new Date(2000), new Date(2000))
  await utimes(join(third, 'run.log'), new Date(3000), new Date(3000))

  await pruneRunArtifacts(artifacts, new Set([first]), 2)

  assert.equal((await stat(first)).isDirectory(), true)
  await assert.rejects(stat(second), { code: 'ENOENT' })
  assert.equal((await stat(third)).isDirectory(), true)
})
