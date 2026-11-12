import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { fork } from 'node:child_process'
import { once } from 'node:events'
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  existsSync,
  statSync
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const runRoot = join(packageRoot, '../../temp/pi/sdk-secrets')
mkdirSync(runRoot, { recursive: true })
const root = mkdtempSync(join(runRoot, 'encrypted-store-'))
process.env.PI_CODING_AGENT_DIR = join(root, 'agent')
process.env.PI_CODING_AGENT_SESSION_DIR = join(root, 'agent/sessions')
const { createSecretStore, isSecretReference } = await import('../dist/secrets.js')

test.after(() => rmSync(root, { recursive: true, force: true }))

function fixture(t) {
  const directory = mkdtempSync(join(root, 'case-'))
  const agentDir = join(directory, 'agent')
  const key = randomBytes(32)
  const store = createSecretStore({ agentDir, keyProvider: async () => key })
  const path = join(agentDir, 'config/credentials.enc')
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  return { directory, agentDir, key, store, path }
}

test('凭据增删改查与导出只操作合法引用，密文不含明文', async (t) => {
  const { store, path, key } = fixture(t)
  const value = 'sdk-only-test-credential-演示'
  const reference = await store.put(value)
  assert.ok(isSecretReference(reference))
  assert.equal(isSecretReference('secret://not-a-uuid'), false)
  assert.equal(isSecretReference(1), false)
  assert.equal(await store.get(reference), value)
  const firstCiphertext = readFileSync(path)
  assert.ok(!firstCiphertext.includes(Buffer.from(value)))
  assert.ok(!firstCiphertext.includes(key))
  assert.equal(await store.put(value, reference), reference)
  assert.notDeepEqual(readFileSync(path), firstCiphertext)
  await store.put('', reference)
  assert.deepEqual(await store.export([reference]), { [reference]: '' })
  await assert.rejects(store.export([`secret://${randomUUID()}`]), /引用不存在/u)
  await assert.rejects(store.get(value), /secret:\/\/UUID/u)
  await assert.rejects(store.put(value, 'invalid'), /secret:\/\/UUID/u)
  await store.delete(reference)
  assert.equal(await store.get(reference), null)
  const after = readFileSync(path)
  await store.delete(reference)
  assert.deepEqual(readFileSync(path), after)
  assert.deepEqual(readdirSync(dirname(path)), ['credentials.enc'])
  if (process.platform !== 'win32') assert.equal(statSync(path).mode & 0o777, 0o600)
})

test('导入每次生成新引用，不覆盖已有用户引用和输入引用', async (t) => {
  const { store, agentDir, key, path } = fixture(t)
  const reference = await store.put('existing-user-value')
  const imported = { [reference]: 'imported-value', [`secret://${randomUUID()}`]: 'second-value' }
  const mapping = await store.import(imported)
  assert.equal(await store.get(reference), 'existing-user-value')
  for (const [oldReference, next] of Object.entries(mapping)) {
    assert.notEqual(next, oldReference)
    assert.ok(isSecretReference(next))
    assert.equal(Object.hasOwn(imported, next), false)
    assert.equal(await store.get(next), imported[oldReference])
  }
  const second = await store.import(imported)
  assert.ok(Object.values(second).every((next) => !Object.values(mapping).includes(next)))
  const reopened = createSecretStore({ agentDir, keyProvider: async () => key })
  assert.deepEqual(
    await reopened.export(Object.values(mapping)),
    Object.fromEntries(Object.entries(mapping).map(([old, next]) => [next, imported[old]]))
  )
  const before = readFileSync(path)
  await assert.rejects(
    store.import({ [reference]: 'safe', invalid: 'must-not-be-written' }),
    /secret:\/\/UUID/u
  )
  assert.deepEqual(readFileSync(path), before)
})

test('错误密钥、密钥不可用和密文篡改均拒绝读写且不覆盖保险库', async (t) => {
  const { store, agentDir, path } = fixture(t)
  const reference = await store.put('authenticated-value')
  const original = readFileSync(path)
  const wrong = createSecretStore({ agentDir, keyProvider: async () => randomBytes(32) })
  await assert.rejects(wrong.get(reference), /认证失败/u)
  await assert.rejects(wrong.put('replacement'), /认证失败/u)
  assert.deepEqual(readFileSync(path), original)
  const unavailable = createSecretStore({
    agentDir,
    keyProvider: async () => {
      throw new Error('private-provider-detail')
    }
  })
  await assert.rejects(unavailable.put('replacement'), /密钥提供器失败/u)
  assert.deepEqual(readFileSync(path), original)
  for (const offset of [0, 8, 20, original.length - 1]) {
    const changed = Buffer.from(original)
    changed[offset] ^= 1
    writeFileSync(path, changed)
    await assert.rejects(store.get(reference), /认证失败/u)
    await assert.rejects(store.put('replacement'), /认证失败/u)
    assert.deepEqual(readFileSync(path), changed)
  }
  writeFileSync(path, original)
  assert.equal(await store.get(reference), 'authenticated-value')
  assert.deepEqual(readdirSync(dirname(path)), ['credentials.enc'])
})

test('并发 Store 实例串行读改写，不丢失任何引用', async (t) => {
  const { agentDir, key, store } = fixture(t)
  const stores = Array.from({ length: 8 }, () =>
    createSecretStore({ agentDir, keyProvider: async () => key })
  )
  const references = await Promise.all(
    stores.map((instance, index) => instance.put(`value-${index}`))
  )
  assert.deepEqual(
    await store.export(references),
    Object.fromEntries(references.map((reference, index) => [reference, `value-${index}`]))
  )
})

async function writeInChild(agentDir, key, index) {
  const child = fork(join(packageRoot, 'tests/fixtures/secrets-worker.mjs'), [], {
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: agentDir,
      PI_CODING_AGENT_SESSION_DIR: join(agentDir, 'sessions')
    }
  })
  let stderr = ''
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString()
  })
  const exited = once(child, 'exit')
  const message = once(child, 'message')
  const timeout = setTimeout(() => child.kill(), 30_000)
  try {
    // 测试密钥只通过 IPC 传输，不进入 argv、环境或日志。
    child.send({ agentDir, key: [...key], index })
    const [result] = await Promise.race([
      message,
      exited.then(() => {
        throw new Error(`凭据测试子进程提前退出：${stderr}`)
      })
    ])
    const [code] = await exited
    assert.equal(code, 0, stderr)
    assert.equal(result.error, undefined)
    return result.references
  } finally {
    clearTimeout(timeout)
    if (child.exitCode === null && child.signalCode === null) {
      child.kill()
      await exited
    }
  }
}

test('跨进程首次创建与并发写入保持所有密文数据', async (t) => {
  const { agentDir, key, store, path } = fixture(t)
  const batches = await Promise.all(
    Array.from({ length: 4 }, (_, index) => writeInChild(agentDir, key, index))
  )
  const references = batches.flat()
  const values = await store.export(references)
  assert.equal(new Set(references).size, 12)
  for (const [index, batch] of batches.entries()) {
    for (const [offset, reference] of batch.entries())
      assert.equal(values[reference], `worker-${index}-${offset}`)
  }
  assert.deepEqual(readdirSync(dirname(path)), ['credentials.enc'])
})

test('持续新增达到记录上限后拒绝写入，保留现有密文且仅显式删除后释放容量', async (t) => {
  const { store, path } = fixture(t)
  const initial = Object.fromEntries(
    Array.from({ length: 4094 }, () => [`secret://${randomUUID()}`, 'fixture-value'])
  )
  const mapping = await store.import(initial)
  const first = await store.put('last-slot-one')
  const second = await store.put('last-slot-two')
  const before = readFileSync(path)
  for (let attempt = 0; attempt < 3; attempt++) {
    await assert.rejects(store.put('must-not-grow'), (error) => {
      assert.match(error.message, /最多保存 4096 条记录/u)
      assert.match(error.message, /仅显式删除已确认不再被任何配置引用/u)
      return true
    })
    assert.deepEqual(readFileSync(path), before)
  }
  assert.deepEqual(await store.export([first]), { [first]: 'last-slot-one' })
  assert.equal(await store.get(Object.values(mapping)[0]), 'fixture-value')
  await store.delete(second)
  const replacement = await store.put('released-slot')
  assert.equal(await store.get(replacement), 'released-slot')
})

test('持续写入达到总密文字节上限后拒绝增长，不清空或重建保险库', async (t) => {
  const { store, path } = fixture(t)
  const value = 'x'.repeat(1024 * 1024)
  const references = []
  for (let index = 0; index < 7; index++) references.push(await store.put(value))
  const before = readFileSync(path)
  assert.ok(before.length <= 8 * 1024 * 1024)
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(store.put(value), (error) => {
      assert.match(error.message, /完整密文不能超过 8 MiB/u)
      assert.match(error.message, /不会自动清空保险库/u)
      return true
    })
    assert.deepEqual(readFileSync(path), before)
  }
  assert.equal((await store.get(references[0])).length, value.length)
  await store.delete(references[0])
  const replacement = await store.put(value)
  assert.equal((await store.get(replacement)).length, value.length)
  assert.ok(statSync(path).size <= 8 * 1024 * 1024)
})

test('外部密钥文件只读使用，缺失或错误时拒绝重建密钥与密文', async (t) => {
  const { directory, agentDir, key, path } = fixture(t)
  const keyFile = join(directory, 'external.key')
  writeFileSync(keyFile, key, { mode: 0o600 })
  const previous = process.env.PI_DESK_SECRET_KEY_FILE
  t.after(() => {
    if (previous === undefined) delete process.env.PI_DESK_SECRET_KEY_FILE
    else process.env.PI_DESK_SECRET_KEY_FILE = previous
  })
  process.env.PI_DESK_SECRET_KEY_FILE = keyFile
  const store = createSecretStore({ agentDir })
  const reference = await store.put('external-key-test-value')
  assert.equal(await store.get(reference), 'external-key-test-value')
  assert.deepEqual(readFileSync(keyFile), key)
  const ciphertext = readFileSync(path)
  process.env.PI_DESK_SECRET_KEY_FILE = join(directory, 'missing.key')
  await assert.rejects(store.put('must-not-write'), /不存在/u)
  assert.equal(existsSync(process.env.PI_DESK_SECRET_KEY_FILE), false)
  assert.deepEqual(readFileSync(path), ciphertext)
  process.env.PI_DESK_SECRET_KEY_FILE = keyFile
  writeFileSync(keyFile, randomBytes(32))
  await assert.rejects(store.put('must-not-write'), /认证失败/u)
  assert.deepEqual(readFileSync(path), ciphertext)
  writeFileSync(keyFile, Buffer.alloc(8))
  await assert.rejects(store.get(reference), /32 字节/u)
  assert.deepEqual(readFileSync(path), ciphertext)
})
