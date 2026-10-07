import assert from 'node:assert/strict'
import test from 'node:test'
import type { PiDeskPluginFacade } from '@jetcrab/pi-desk-sdk/entry'
import pluginDefinition from '../src/pi-desk.js'

test('Pi Desk Entry 注册远程调试和配置方法及唯一 Browser Entry', async () => {
  const methods: string[] = []
  const browserEntries: string[] = []
  const facade: PiDeskPluginFacade = {
    name: 'remote-debug',
    notifications: {
      publish: () => '11111111-1111-4111-8111-111111111111',
      update: () => undefined,
      delete: () => undefined
    },
    setState: () => undefined,
    host: {
      settings: {
        getSnapshot: () => ({ region: { locale: 'en', timeZone: 'UTC' } }),
        subscribe: () => () => undefined
      },
      workSessions: { listWorkSessions: async () => [] }
    },
    registerMethod(method) {
      methods.push(method)
      return () => undefined
    },
    registerBrowserEntry(path) {
      browserEntries.push(path)
      return () => undefined
    },
    declareCapabilities: () => () => undefined,
    declareMessage: () => () => undefined,
    pushGlobal: () => undefined,
    pushSession: () => undefined
  }

  const disposer = await pluginDefinition.setup(facade)

  assert.deepEqual(methods.sort(), [
    'catalog-get',
    'registration-delete',
    'run-start',
    'run-stop',
    'settings-get',
    'settings-save'
  ])
  assert.deepEqual(browserEntries, ['./dist/browser/entry.js'])
  assert.equal(typeof disposer, 'function')
  if (typeof disposer === 'function') await disposer()
})
