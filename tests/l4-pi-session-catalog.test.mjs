import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import Module, { syncBuiltinESMExports } from 'node:module'
import { join, resolve } from 'node:path'
import test from 'node:test'
import * as pi from '@earendil-works/pi-coding-agent'

const originalLoad = Module._load
Module._load = function load(request, parent, isMain) {
  if (request === 'server-only') return {}
  if (request === '@earendil-works/pi-coding-agent') return pi
  return originalLoad.call(this, request, parent, isMain)
}
const catalog = await import('../src/server/l4_foundation/pi/l4-pi-session-catalog.ts')
const { findL4PiSessionFile } =
  await import('../src/server/l4_foundation/pi/l4-pi-session-discovery.ts')
Module._load = originalLoad

async function fixture(context) {
  const root = resolve('temp/run/session-catalog', `metadata-lookup-${randomUUID()}`)
  const agentDir = join(root, 'agent')
  const keys = ['PI_CODING_AGENT_DIR', 'PI_CODING_AGENT_SESSION_DIR']
  const previous = new Map(keys.map((key) => [key, process.env[key]]))
  await fs.mkdir(agentDir, { recursive: true })
  process.env.PI_CODING_AGENT_DIR = agentDir
  process.env.PI_CODING_AGENT_SESSION_DIR = join(agentDir, 'sessions')
  for (const name of ['__piDeskPiSessionCatalogState', '__piDeskPiSessionHistoryCatalogState']) {
    Reflect.deleteProperty(globalThis, name)
  }
  context.mock.method(pi.SessionManager, 'list', () => {
    throw new Error('不得读取完整会话列表')
  })
  context.mock.method(pi.SessionManager, 'listAll', () => {
    throw new Error('不得读取所有会话正文')
  })
  context.after(async () => {
    await globalThis.__piDeskPiSessionCatalogState?.directorySummaryCache
    context.mock.restoreAll()
    syncBuiltinESMExports()
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    for (const name of ['__piDeskPiSessionCatalogState', '__piDeskPiSessionHistoryCatalogState']) {
      Reflect.deleteProperty(globalThis, name)
    }
    await fs.rm(root, { recursive: true, force: true })
  })
  return { root, agentDir }
}

async function session(cwd, id, { name, prefix = '', body = 'x'.repeat(2 * 1024 * 1024) } = {}) {
  const directory = pi.SessionManager.create(cwd).getSessionDir()
  const path = join(directory, name ?? `2026-01-01T00-00-00-000Z_${id}.jsonl`)
  await fs.writeFile(
    path,
    `${prefix}${JSON.stringify({ type: 'session', version: 3, id, cwd, timestamp: '2026-01-01T00:00:00.000Z' })}\n${body}`
  )
  return path
}

function observeHeaderReads(context) {
  const opened = []
  let bytes = 0
  const open = fs.open
  context.mock.method(fs, 'open', async (...args) => {
    const handle = await open(...args)
    opened.push(resolve(String(args[0])))
    const read = handle.read.bind(handle)
    context.mock.method(handle, 'read', async (...readArgs) => {
      const result = await read(...readArgs)
      bytes += result.bytesRead
      return result
    })
    return handle
  })
  syncBuiltinESMExports()
  return { opened, bytes: () => bytes }
}

test('冷启动按 ID 定位目标文件，不读取其他会话正文或建立目录缓存', async (context) => {
  const { root, agentDir } = await fixture(context)
  const cwd = join(root, 'project')
  const target = await session(cwd, 'target-session')
  await session(cwd, 'unrelated-session')
  await session(join(root, 'other-project'), 'other-session')
  context.mock.method(pi.SessionManager, 'findById', () => {
    throw new Error('标准文件名不应遍历其他文件头')
  })
  const reads = observeHeaderReads(context)
  assert.equal(await catalog.resolveL4PiSessionPath(cwd, 'target-session'), target)
  assert.deepEqual(reads.opened, [target])
  assert.ok(reads.bytes() <= 4096, '定位只需读取目标文件头')
  await assert.rejects(fs.stat(join(agentDir, 'pi-desk', 'pi-directories.json')), {
    code: 'ENOENT'
  })
})

test('定向发现兼容重命名文件，并拒绝错误项目、错误 ID 和过期路径', async (context) => {
  const { root } = await fixture(context)
  const cwd = join(root, 'project')
  const renamed = await session(cwd, 'renamed-session', {
    name: 'legacy.jsonl',
    prefix: '\nnot-json\n'
  })
  assert.equal(await catalog.resolveL4PiSessionPath(cwd, 'renamed-session'), renamed)
  const target = await session(cwd, 'target-session')
  const staleCopy = join(root, 'stale-target.jsonl')
  await fs.copyFile(target, staleCopy)
  assert.equal(await findL4PiSessionFile(cwd, 'target-session', staleCopy), target)
  assert.equal(await findL4PiSessionFile(cwd, 'target-session', renamed), target)
  await fs.rm(target)
  assert.equal(await findL4PiSessionFile(cwd, 'target-session', target), null)
  assert.equal(await catalog.resolveL4PiSessionPath(cwd, 'missing-session'), null)
  const foreign = await session(join(root, 'foreign'), 'foreign-session')
  const destination = join(
    pi.SessionManager.create(cwd).getSessionDir(),
    '2026_foreign-session.jsonl'
  )
  await fs.copyFile(foreign, destination)
  assert.equal(await catalog.resolveL4PiSessionPath(cwd, 'foreign-session'), null)
})

test('目录摘要只读取文件头和属性；本地新增会话不立即重扫所有项目', async (context) => {
  const { root, agentDir } = await fixture(context)
  const cwdA = join(root, 'a')
  const cwdB = join(root, 'b')
  const a = await session(cwdA, 'a-session')
  const b = await session(cwdB, 'b-session', { name: 'renamed.jsonl' })
  const updatedA = new Date('2026-01-02T00:00:00.000Z')
  const updatedB = new Date('2026-01-03T00:00:00.000Z')
  await fs.utimes(a, updatedA, updatedA)
  await fs.utimes(b, updatedB, updatedB)
  const reads = observeHeaderReads(context)
  assert.deepEqual(await catalog.listL4PiDirectorySummaries(true), [
    { cwd: cwdB, sessionCount: 1, updatedAt: updatedB.getTime() },
    { cwd: cwdA, sessionCount: 1, updatedAt: updatedA.getTime() }
  ])
  assert.ok(reads.bytes() <= 2 * 4096, '目录发现不得读取历史正文')
  const enumerate = context.mock.method(fs, 'readdir')
  syncBuiltinESMExports()
  catalog.invalidateL4PiDirectoryCache(cwdA)
  const directories = await catalog.listL4PiDirectories()
  assert.equal(directories.find((item) => item.cwd === cwdA).sessionCount, 2)
  assert.equal(enumerate.mock.calls.length, 0, '新增会话及后续查询只复用本项目摘要更新')
  const saved = JSON.parse(
    await fs.readFile(join(agentDir, 'pi-desk', 'pi-directories.json'), 'utf8')
  )
  assert.equal(saved.directories.find((item) => item.cwd === cwdA).sessionCount, 2)
})
