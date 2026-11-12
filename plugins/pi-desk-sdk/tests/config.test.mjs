import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { fork } from 'node:child_process'
import { once } from 'node:events'
import fs, {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  existsSync
} from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { dirname, basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const runRoot = join(packageRoot, '../../temp/pi/sdk-config')
mkdirSync(runRoot, { recursive: true })
const root = mkdtempSync(join(runRoot, 'config-transactions-'))
process.env.PI_CODING_AGENT_DIR = join(root, 'agent')
process.env.PI_CODING_AGENT_SESSION_DIR = join(root, 'agent/sessions')
const configApi = await import('@jetcrab/pi-desk-sdk/config')
const { getConfigDirectory, getConfigPath, withConfigTransaction, writeConfigTextAtomic } =
  configApi
const { createSecretStore } = await import('@jetcrab/pi-desk-sdk/secrets')

test.after(() => rmSync(root, { recursive: true, force: true }))

function fixture(t) {
  const directory = mkdtempSync(join(root, 'case-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  return { directory, agentDir: join(directory, 'agent') }
}

function put(path, content) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

test('配置入口提供绑定存储与文件工具，路径查询不创建目录且拒绝越界文件名', (t) => {
  const { agentDir } = fixture(t)
  assert.deepEqual(Object.keys(configApi).sort(), [
    'bindConfigStore',
    'getConfigDirectory',
    'getConfigPath',
    'getUnifiedConfigPath',
    'readConfigSection',
    'withConfigTransaction',
    'writeConfigTextAtomic'
  ])
  assert.equal(getConfigDirectory(), join(process.env.PI_CODING_AGENT_DIR, 'config'))
  assert.equal(getConfigPath('plugin.json', agentDir), join(agentDir, 'config/plugin.json'))
  assert.equal(existsSync(agentDir), false)
  for (const filename of ['', '.', '..', '../a', 'a/b', 'a\\b', 'C:a', 'a\0b']) {
    assert.throws(() => getConfigPath(filename, agentDir), /单个文件名/u)
  }
})

test('查询和发布只操作最新路径，不读取或修改旧配置及其字段', async (t) => {
  const { agentDir } = fixture(t)
  const oldFiles = new Map([
    [join(agentDir, 'settings.json'), '// 旧设置\r\n{"agents":{"test":true},"native":1}\r\n'],
    [join(agentDir, 'models.json'), '{"modelPresets":["old-test"],"providers":{}}'],
    [join(agentDir, 'plugin.json'), '旧版本格式，不应解析或搬运']
  ])
  for (const [path, content] of oldFiles) put(path, content)
  const targetPath = getConfigPath('plugin.json', agentDir)
  assert.equal(existsSync(dirname(targetPath)), false)
  let oldAccesses = 0
  const mocks = [
    'lstatSync',
    'openSync',
    'readFileSync',
    'writeFileSync',
    'unlinkSync',
    'renameSync',
    'linkSync'
  ].map((method) => {
    const original = fs[method]
    return t.mock.method(fs, method, (...args) => {
      if (args.some((value) => typeof value === 'string' && oldFiles.has(resolve(value)))) {
        oldAccesses++
        throw new Error('SDK 不应访问旧配置')
      }
      return original(...args)
    })
  })
  syncBuiltinESMExports()
  try {
    assert.equal(getConfigDirectory(agentDir), join(agentDir, 'config'))
    assert.equal(getConfigPath('plugin.json', agentDir), targetPath)
    assert.equal(existsSync(dirname(targetPath)), false)
    await withConfigTransaction(targetPath, async () => {
      writeConfigTextAtomic(targetPath, '{"current":true}')
    })
    assert.deepEqual(readJson(targetPath), { current: true })
    assert.equal(oldAccesses, 0)
  } finally {
    for (const mock of mocks) mock.mock.restore()
    syncBuiltinESMExports()
  }
  for (const [path, content] of oldFiles) assert.equal(readFileSync(path, 'utf8'), content)
})

test('最新路径拒绝符号链接目录和非普通目标，操作回调不会执行', async (t) => {
  const { directory, agentDir } = fixture(t)
  const real = join(directory, 'real')
  mkdirSync(real)
  const linked = join(directory, 'linked')
  symlinkSync(real, linked, process.platform === 'win32' ? 'junction' : 'dir')
  const linkedTarget = join(linked, 'plugin.json')
  assert.throws(() => writeConfigTextAtomic(linkedTarget, '{}'), /普通目录/u)
  await assert.rejects(
    withConfigTransaction(linkedTarget, async () => {
      assert.fail('不应执行回调')
    }),
    /普通目录/u
  )
  assert.equal(existsSync(join(real, 'plugin.json')), false)
  const target = getConfigPath('plugin.json', agentDir)
  mkdirSync(target, { recursive: true })
  assert.throws(() => writeConfigTextAtomic(target, '{}'), /非普通配置文件/u)
  await assert.rejects(
    withConfigTransaction(target, async () => {
      assert.fail('不应执行回调')
    }),
    /非普通配置文件/u
  )
  assert.equal(existsSync(`${target}.lock`), false)
})

test('最新配置事务跨进程序列化读取、分配引用与原子发布，不丢失配置或凭据', async (t) => {
  const { directory, agentDir } = fixture(t)
  const targetPath = getConfigPath('transaction.json', agentDir)
  const eventsPath = join(directory, 'events.jsonl')
  const key = randomBytes(32)
  put(targetPath, JSON.stringify({ items: [], unknown: { retain: true } }))
  const batches = await Promise.all(
    Array.from({ length: 4 }, async (_, index) => {
      const child = fork(join(packageRoot, 'tests/fixtures/config-worker.mjs'), [], {
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
        child.send({ agentDir, key: [...key], index, targetPath, eventsPath })
        const [result] = await Promise.race([
          message,
          exited.then(() => {
            throw new Error(`配置事务测试子进程提前退出：${stderr}`)
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
    })
  )
  const config = readJson(targetPath)
  assert.deepEqual(config.unknown, { retain: true })
  assert.equal(config.items.length, 12)
  assert.deepEqual(new Set(config.items), new Set(batches.flat()))
  const store = createSecretStore({ agentDir, keyProvider: async () => key })
  const values = await store.export(config.items)
  for (const [index, batch] of batches.entries()) {
    for (const [offset, reference] of batch.entries())
      assert.equal(values[reference], `worker-${index}-${offset}`)
  }
  const events = readFileSync(eventsPath, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  assert.equal(events.length, 24)
  for (let index = 0; index < events.length; index += 2) {
    assert.deepEqual(events[index + 1], { ...events[index], phase: 'exit' })
    assert.equal(events[index].phase, 'enter')
  }
  assert.deepEqual(readdirSync(dirname(targetPath)).sort(), ['credentials.enc', 'transaction.json'])
})

test('替换配置保留其他项目共享的已发布旧引用，导出只包含所选引用', async (t) => {
  const { agentDir } = fixture(t)
  const key = randomBytes(32)
  const store = createSecretStore({ agentDir, keyProvider: async () => key })
  const oldReference = await store.put('shared-project-value')
  const firstPath = getConfigPath('project-a.json', agentDir)
  const secondPath = getConfigPath('project-b.json', agentDir)
  writeConfigTextAtomic(firstPath, JSON.stringify({ reference: oldReference }))
  writeConfigTextAtomic(secondPath, JSON.stringify({ reference: oldReference }))
  const next = await withConfigTransaction(firstPath, async () => {
    const reference = await store.put('project-a-new-value')
    writeConfigTextAtomic(firstPath, JSON.stringify({ reference }))
    return reference
  })
  assert.equal(readJson(firstPath).reference, next)
  assert.equal(readJson(secondPath).reference, oldReference)
  assert.equal(await store.get(oldReference), 'shared-project-value')
  assert.deepEqual(await store.export([next]), { [next]: 'project-a-new-value' })
})

test('配置发布后的临时清理失败不误报未提交，不回收已引用凭据', async (t) => {
  const { agentDir } = fixture(t)
  const key = randomBytes(32)
  const store = createSecretStore({ agentDir, keyProvider: async () => key })
  const reference = await store.put('published-test-value')
  const targetPath = getConfigPath('published.json', agentDir)
  const originalUnlink = fs.unlinkSync
  const unlink = t.mock.method(fs, 'unlinkSync', (path) => {
    if (basename(path).startsWith('.published.json.') && path.endsWith('.tmp')) {
      throw Object.assign(new Error('测试临时文件清理失败'), { code: 'EPERM' })
    }
    return originalUnlink(path)
  })
  const warnings = t.mock.method(console, 'warn', () => {})
  syncBuiltinESMExports()
  let reclaimed = false
  try {
    const result = await withConfigTransaction(targetPath, async () => {
      try {
        writeConfigTextAtomic(targetPath, JSON.stringify({ reference }))
      } catch (error) {
        reclaimed = true
        await store.delete(reference)
        throw error
      }
      return 'published'
    })
    assert.equal(result, 'published')
    assert.equal(reclaimed, false)
    assert.equal(readJson(targetPath).reference, reference)
    assert.equal(await store.get(reference), 'published-test-value')
    assert.ok(warnings.mock.calls.some((call) => call.arguments[0].includes('配置已提交')))
    assert.equal(readdirSync(dirname(targetPath)).filter((name) => name.endsWith('.tmp')).length, 1)
  } finally {
    unlink.mock.restore()
    warnings.mock.restore()
    syncBuiltinESMExports()
  }
})

test('事务成功后的锁释放告警不改变提交结果，操作失败仍抛原始错误并释放锁', async (t) => {
  const { agentDir } = fixture(t)
  const targetPath = getConfigPath('lock-release.json', agentDir)
  const lockfile = (await import('proper-lockfile')).default
  const originalLock = lockfile.lock
  const lock = t.mock.method(lockfile, 'lock', async (...args) => {
    const release = await originalLock(...args)
    return async () => {
      await release()
      throw Object.assign(new Error('测试锁释放失败'), { code: 'EIO' })
    }
  })
  const warnings = t.mock.method(console, 'warn', () => {})
  try {
    assert.equal(
      await withConfigTransaction(targetPath, async () => {
        writeConfigTextAtomic(targetPath, '{"committed":true}')
        return 42
      }),
      42
    )
    assert.deepEqual(readJson(targetPath), { committed: true })
    const failure = new Error('原始操作错误')
    await assert.rejects(
      withConfigTransaction(targetPath, async () => {
        throw failure
      }),
      (error) => error === failure
    )
    assert.equal(existsSync(`${targetPath}.lock`), false)
    assert.equal(warnings.mock.calls.length, 2)
  } finally {
    lock.mock.restore()
    warnings.mock.restore()
  }
})
