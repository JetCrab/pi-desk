import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

const script = await readFile(
  new URL('../apps/desktop/src-tauri/src/window-chrome.js', import.meta.url),
  'utf8'
)

test('窗口挂载、释放和再次挂载依次完成，失败不阻断后续操作', async () => {
  const started = []
  const pending = []
  const window = {
    __TAURI_INTERNALS__: {
      invoke(command, { action }) {
        assert.equal(command, 'plugin:window-chrome|bridge')
        started.push(action)
        return new Promise((resolve, reject) => pending.push({ resolve, reject }))
      }
    }
  }
  vm.runInNewContext(script, { window })
  assert.equal(Object.isFrozen(window.__PI_DESK_WINDOW__), true)
  const first = window.__PI_DESK_WINDOW__.invoke('attach')
  const cleanup = window.__PI_DESK_WINDOW__.invoke('detach')
  const last = window.__PI_DESK_WINDOW__.invoke('attach')
  await Promise.resolve()
  assert.deepEqual(started, ['attach'])
  pending[0].resolve({ maximized: false })
  await first
  await Promise.resolve()
  assert.deepEqual(started, ['attach', 'detach'])
  const expectedError = new Error('窗口切换失败')
  const rejection = assert.rejects(cleanup, (error) => error === expectedError)
  pending[1].reject(expectedError)
  await rejection
  await Promise.resolve()
  assert.deepEqual(started, ['attach', 'detach', 'attach'])
  pending[2].resolve({ maximized: true })
  assert.deepEqual(await last, { maximized: true })
})
