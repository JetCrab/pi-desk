import assert from 'node:assert/strict'
import { appendFile, mkdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import test from 'node:test'
import {
  L4TextLogPool,
  type L4TextLogEvent
} from '../src/server/l4_foundation/file/l4-text-log-runtime'

const testRoot = resolve('temp', 'pi', 'text-log-runtime-test', String(process.pid))

async function waitForEvent(
  events: readonly L4TextLogEvent[],
  predicate: (event: L4TextLogEvent) => boolean
): Promise<L4TextLogEvent> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const event = events.find(predicate)
    if (event) return event
    await new Promise((resolveWait) => setTimeout(resolveWait, 25))
  }
  throw new Error(`等待日志事件超时：${JSON.stringify(events)}`)
}

test('文本日志观察支持缺失文件、追加、重写和共享监听', async (context) => {
  await mkdir(testRoot, { recursive: true })
  context.after(async () => rm(testRoot, { recursive: true, force: true }))
  const path = join(testRoot, 'build.log')
  const pool = new L4TextLogPool()
  context.after(() => pool.dispose())
  const firstEvents: L4TextLogEvent[] = []
  const secondEvents: L4TextLogEvent[] = []

  const first = await pool.observe(path, (event) => firstEvents.push(event))
  const second = await pool.observe(path, (event) => secondEvents.push(event))
  assert.deepEqual(first.snapshot, { text: '', truncated: false })
  assert.deepEqual(second.snapshot, { text: '', truncated: false })

  await writeFile(path, '\u001b[31m开始构建\u001b[0m\n', 'utf8')
  await waitForEvent(firstEvents, (event) => event.type === 'text_append')
  await waitForEvent(secondEvents, (event) => event.type === 'text_append')
  assert.equal(first.readSnapshot().text, '开始构建\n')

  firstEvents.length = 0
  await appendFile(path, '上传完成\n', 'utf8')
  const append = await waitForEvent(
    firstEvents,
    (event) => event.type === 'text_append' && event.text.includes('上传完成')
  )
  assert.equal(append.type, 'text_append')
  assert.equal(first.readSnapshot().text, '开始构建\n上传完成\n')

  firstEvents.length = 0
  await writeFile(path, '重新开始\n', 'utf8')
  const replacement = await waitForEvent(firstEvents, (event) => event.type === 'snapshot')
  assert.equal(replacement.type, 'snapshot')
  if (replacement.type === 'snapshot') {
    assert.deepEqual(replacement.snapshot, { text: '重新开始\n', truncated: false })
  }

  first.release()
  second.release()
  first.release()
})

test('文本日志观察拒绝相对路径', async () => {
  const pool = new L4TextLogPool()
  await assert.rejects(
    pool.observe('temp/build.log', () => undefined),
    /absolute path/
  )
  pool.dispose()
})
