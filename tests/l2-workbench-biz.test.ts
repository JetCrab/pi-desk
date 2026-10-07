import assert from 'node:assert/strict'
import test from 'node:test'
import { createL2WorkbenchBiz } from '../src/client/l2_biz/workbench/l2-workbench-biz'
import type { L4AppSocketClient } from '../src/client/l4_foundation/realtime/app-socket/l4-app-socket'
import type { L4AppSocketRequestContract } from '../src/common/l4_foundation/realtime/l4-app-websocket-contract'

for (const stage of ['connect', 'snapshot'] as const) {
  test(`中止${stage}阶段的旧初始化不能应用快照并释放业务监听`, async () => {
    const controller = new AbortController()
    let resolveConnect!: (value: boolean) => void
    let resolveSnapshot!: () => void
    let requests = 0
    let applied = 0
    let released = 0
    const socket: L4AppSocketClient = {
      connect: () =>
        new Promise((resolve) => {
          resolveConnect = resolve
        }),
      request<Input, Output>(contract: L4AppSocketRequestContract<Input, Output>): Promise<Output> {
        requests += 1
        return new Promise((resolve) => {
          resolveSnapshot = () =>
            resolve(
              contract.outputSchema.parse({
                workSessions: [],
                pinnedCount: 0,
                appRuntime: { mode: 'normal', notifications: [], plugins: {}, capabilityModes: {} }
              })
            )
        })
      },
      subscribe: () => () => {
        released += 1
      },
      waitForClose: () => new Promise(() => undefined)
    }
    const biz = createL2WorkbenchBiz('11111111-1111-4111-8111-111111111111', socket)
    const pending = biz.readWorkSessionUpdates(
      controller.signal,
      () => {
        applied += 1
      },
      () => undefined,
      () => undefined
    )
    if (stage === 'connect') {
      controller.abort()
      resolveConnect(true)
    } else {
      resolveConnect(true)
      await new Promise((resolve) => setImmediate(resolve))
      assert.equal(requests, 1)
      controller.abort()
      resolveSnapshot()
    }
    await pending
    assert.equal(applied, 0)
    assert.equal(released, 2)
    assert.equal(requests, stage === 'connect' ? 0 : 1)
  })
}
