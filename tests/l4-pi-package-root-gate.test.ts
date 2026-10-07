import assert from 'node:assert/strict'
import test from 'node:test'
import { runL4PiPackageRootExclusive } from '../src/server/l4_foundation/pi/l4-pi-package-root-gate'

test('安装目录写入与资源发现互斥，结束后不阻止后续初始化', async () => {
  let release!: () => void
  const blocked = new Promise<void>((resolve) => {
    release = resolve
  })
  const events: string[] = []
  const writing = runL4PiPackageRootExclusive(async () => {
    events.push('write:start')
    await blocked
    events.push('write:end')
  })
  const discovery = runL4PiPackageRootExclusive(async () => {
    events.push('discover')
  })
  await Promise.resolve()
  assert.deepEqual(events, ['write:start'])
  release()
  await Promise.all([writing, discovery])
  await runL4PiPackageRootExclusive(async () => {
    events.push('next')
  })
  assert.deepEqual(events, ['write:start', 'write:end', 'discover', 'next'])
})

test('目录操作失败不会留下全局等待重启标记', async () => {
  await assert.rejects(
    runL4PiPackageRootExclusive(async () => {
      throw new Error('fixture')
    })
  )
  assert.equal(await runL4PiPackageRootExclusive(async () => 'ready'), 'ready')
})
