import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import { mock } from 'node:test'
import type { SecretStore } from '@jetcrab/pi-desk-sdk/secrets'
import type { StoredConfig } from '../src/l2-quota-config.js'

const agentDir = process.argv[2]
const mode = process.argv[3]
const path = join(agentDir, 'config', 'pi-desk-quota-viewer.json')

function send(kind: string, data: Record<string, string> = {}): void {
  process.send?.({ kind, ...data })
}

function receive(kind: string): Promise<{ kind: string; value: StoredConfig }> {
  return new Promise((resolve) => {
    const listener = (message: { kind: string; value: StoredConfig }): void => {
      if (message.kind !== kind) return
      process.off('message', listener)
      resolve(message)
    }
    process.on('message', listener)
  })
}

// 等真实锁冲突后才放行另一进程，不用延时猜测事务是否已经交错。
const mkdir = fs.mkdir
mock.method(fs, 'mkdir', (...args: unknown[]) => {
  const callback = args.at(-1) as (error: NodeJS.ErrnoException | null) => void
  const lockPath = String(args[0])
  args[args.length - 1] = (error: NodeJS.ErrnoException | null): void => {
    if (error?.code === 'EEXIST' && lockPath.includes('pi-desk-quota-viewer.json')) {
      send('lock-contended')
    }
    callback(error)
  }
  return Reflect.apply(mkdir, fs, args)
})

const writeFileSync = fs.writeFileSync
mock.method(fs, 'writeFileSync', (...args: unknown[]) => {
  const content = args[1]
  if (
    (typeof content === 'string' || Buffer.isBuffer(content)) &&
    content.includes('test-only-api-key')
  ) {
    send('plaintext-write')
  }
  return Reflect.apply(writeFileSync, fs, args)
})

if (mode === 'cleanup-failure') {
  const unlinkSync = fs.unlinkSync
  let injected = false
  mock.method(fs, 'unlinkSync', (file: fs.PathLike): void => {
    const filename = String(file)
    if (
      !injected &&
      filename.includes('.pi-desk-quota-viewer.json.') &&
      filename.endsWith('.tmp')
    ) {
      injected = true
      send('cleanup-failed')
      throw Object.assign(new Error('测试提交后清理失败'), { code: 'EACCES' })
    }
    unlinkSync(file)
  })
}
syncBuiltinESMExports()

const { createSecretStore } = await import('@jetcrab/pi-desk-sdk/secrets')
const { quotaAdapterRegistry } = await import('../src/adapters/registry.js')
const { readStoredConfig, writeStoredConfig } = await import('../src/l2-quota-config.js')
const store = createSecretStore({ agentDir, keyProvider: async () => new Uint8Array(32).fill(11) })
let held = false
const allocated = new Set<string>()
const controlled: SecretStore = {
  async get(reference) {
    send('reference-read', { reference })
    if (
      !held &&
      mode === 'hold-after-publish' &&
      allocated.has(reference) &&
      fs.existsSync(path) &&
      (JSON.parse(fs.readFileSync(path, 'utf8')) as StoredConfig).sources.some(
        (source) => source.config.managementKey === reference
      )
    ) {
      held = true
      const continuation = receive('continue')
      send('published', { reference })
      await continuation
    }
    return store.get(reference)
  },
  async put(value, reference) {
    const result = await store.put(value, reference)
    allocated.add(result)
    if (!held && mode === 'hold-write') {
      held = true
      const continuation = receive('continue')
      send('allocated', { reference: result })
      await continuation
    }
    return result
  },
  async delete(reference) {
    send('reference-deleted', { reference })
    await store.delete(reference)
  },
  export: (references) => store.export(references),
  import: (values) => store.import(values)
}

const input = receive('start')
send('ready')
try {
  const { value } = await input
  send('started')
  if (mode === 'read') {
    await readStoredConfig(path, quotaAdapterRegistry, controlled)
  } else {
    await writeStoredConfig(path, value, quotaAdapterRegistry, controlled)
  }
  send('done')
} catch (error) {
  send('error', { message: error instanceof Error ? error.message : String(error) })
} finally {
  mock.restoreAll()
  syncBuiltinESMExports()
  process.disconnect?.()
}
