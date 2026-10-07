import assert from 'node:assert/strict'
import test from 'node:test'
import type { GlobalPluginMethodHandler, PiDeskPluginFacade } from '@jetcrab/pi-desk-sdk/entry'
import definition from '../src/pi-desk.js'

function facade(registrations: {
  methods: string[]
  browserEntries: string[]
}): PiDeskPluginFacade {
  return {
    name: 'quota-viewer',
    host: {
      settings: {
        getSnapshot: () => ({ region: { locale: 'en', timeZone: 'UTC' } }),
        subscribe: () => () => undefined
      },
      workSessions: { listWorkSessions: async () => [] }
    },
    notifications: {
      publish: () => '11111111-1111-4111-8111-111111111111',
      update: () => undefined,
      delete: () => undefined
    },
    setState: () => undefined,
    registerMethod(name: string, _handler: GlobalPluginMethodHandler) {
      registrations.methods.push(name)
      return () => undefined
    },
    registerBrowserEntry(path: string) {
      registrations.browserEntries.push(path)
      return () => undefined
    },
    declareCapabilities: () => () => undefined,
    declareMessage: () => () => undefined,
    pushGlobal() {},
    pushSession() {}
  }
}

test('Node Entry 只注册 Global Methods 和轻量 Browser Entry', async () => {
  const registrations = { methods: [] as string[], browserEntries: [] as string[] }
  const dispose = await definition.setup(facade(registrations))
  assert.deepEqual(registrations.methods, ['state-get', 'settings-get', 'settings-save'])
  assert.deepEqual(registrations.browserEntries, ['./dist/browser/entry.js'])
  if (typeof dispose === 'function') await dispose()
  else await dispose?.dispose?.()
})
