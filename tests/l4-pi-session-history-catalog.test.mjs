import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import Module, { syncBuiltinESMExports } from 'node:module'
import fs from 'node:fs'
import { readFile, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

const projectRoot = resolve(import.meta.dirname, '..')
const catalogModuleUrl = pathToFileURL(
  resolve(projectRoot, 'src/server/l4_foundation/pi/l4-pi-session-history-catalog.ts')
).href

function parseSessionEntries(text) {
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line))
}

const originalLoad = Module._load
Module._load = function load(request, parent, isMain) {
  if (request === 'server-only') return {}
  if (request === '@earendil-works/pi-coding-agent') {
    return {
      CURRENT_SESSION_VERSION: 1,
      getAgentDir: () => process.env.PI_CODING_AGENT_DIR,
      migrateSessionEntries: () => undefined,
      parseSessionEntries,
      SessionManager: {
        findById: () => undefined,
        create: () => ({
          getSessionDir: () => process.env.PI_CODING_AGENT_SESSION_DIR
        })
      }
    }
  }
  return originalLoad.call(this, request, parent, isMain)
}
const { listL4PiSessionHistory, listL4PiSessionUserMessages } = await import(catalogModuleUrl)
Module._load = originalLoad

async function createIsolatedAgent(context) {
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR
  const originalSessionDir = process.env.PI_CODING_AGENT_SESSION_DIR
  const runRoot = join(projectRoot, 'temp/run/session-history')
  await mkdir(runRoot, { recursive: true })
  const testRoot = await mkdtemp(join(runRoot, 'history-cache-'))
  const agentDir = join(testRoot, 'agent')
  await mkdir(agentDir, { recursive: true })
  context.after(async () => {
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir
    if (originalSessionDir === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR
    else process.env.PI_CODING_AGENT_SESSION_DIR = originalSessionDir
    clearTimeout(globalThis.__piDeskPiSessionHistoryCatalogState?.cleanupTimer)
    Reflect.deleteProperty(globalThis, '__piDeskPiSessionHistoryCatalogState')
    await rm(testRoot, { recursive: true, force: true })
  })
  return { testRoot, agentDir }
}

function prepareHistoryProbe(agentDir) {
  process.env.PI_CODING_AGENT_DIR = agentDir
  process.env.PI_CODING_AGENT_SESSION_DIR = join(agentDir, 'sessions')
  clearTimeout(globalThis.__piDeskPiSessionHistoryCatalogState?.cleanupTimer)
  Reflect.deleteProperty(globalThis, '__piDeskPiSessionHistoryCatalogState')
}

async function runHistoryProbe(agentDir, cwd) {
  prepareHistoryProbe(agentDir)
  return listL4PiSessionHistory(cwd)
}

function sessionLine(entry) {
  return `${JSON.stringify(entry)}\n`
}

function messageEntry(id, parentId, role, content, index) {
  return {
    type: 'message',
    id,
    parentId,
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
    message: { role, content }
  }
}

async function createSessionFile(agentDir, cwd, { fileName, sessionId, messages }) {
  const sessionDirectory = join(agentDir, 'sessions')
  const sessionFile = join(sessionDirectory, fileName)
  await mkdir(sessionDirectory, { recursive: true })
  let parentId = null
  const messageEntries = messages.map((message, index) => {
    const entry = messageEntry(message.id, parentId, message.role, message.text, index + 1)
    parentId = message.id
    return entry
  })
  await writeFile(
    sessionFile,
    [
      {
        type: 'session',
        version: 1,
        id: sessionId,
        cwd,
        timestamp: '2026-01-01T00:00:00.000Z'
      },
      ...messageEntries
    ]
      .map(sessionLine)
      .join(''),
    'utf8'
  )
  return sessionFile
}

function persistedCatalogPath(agentDir, cwd) {
  const name = createHash('sha256').update(resolve(cwd)).digest('hex')
  return join(agentDir, 'pi-desk', 'pi-session-history', `${name}.json`)
}

test('按项目分片缓存，只重写当前项目并在 JSONL 变化或缓存损坏后回退', async (context) => {
  const { testRoot, agentDir } = await createIsolatedAgent(context)
  const cwdA = join(testRoot, 'project-a')
  const cwdB = join(testRoot, 'project-b')
  await Promise.all([mkdir(cwdA), mkdir(cwdB)])
  const sessionA = await createSessionFile(agentDir, cwdA, {
    fileName: 'session-a.jsonl',
    sessionId: 'session-a',
    messages: [
      { id: 'user-a', role: 'user', text: 'project-a-first' },
      { id: 'assistant-a', role: 'assistant', text: 'answer-a' }
    ]
  })
  await createSessionFile(agentDir, cwdB, {
    fileName: 'session-b.jsonl',
    sessionId: 'session-b',
    messages: [{ id: 'user-b', role: 'user', text: 'project-b-first' }]
  })

  const initialA = await runHistoryProbe(agentDir, cwdA)
  const initialB = await runHistoryProbe(agentDir, cwdB)
  assert.equal(initialA.length, 1)
  assert.equal(initialB.length, 1)
  const cacheA = persistedCatalogPath(agentDir, cwdA)
  const cacheB = persistedCatalogPath(agentDir, cwdB)
  const cacheBBeforeRefresh = await readFile(cacheB, 'utf8')
  const firstCatalogA = JSON.parse(await readFile(cacheA, 'utf8'))
  const firstCatalogB = JSON.parse(await readFile(cacheB, 'utf8'))
  assert.notEqual(cacheA, cacheB)
  assert.equal(firstCatalogA.version, 2)
  assert.equal(firstCatalogA.cwd, resolve(cwdA))
  assert.equal(firstCatalogA.files.length, 2)
  assert.equal(firstCatalogB.cwd, resolve(cwdB))

  await writeFile(
    sessionA,
    `${await readFile(sessionA, 'utf8')}${sessionLine(
      messageEntry('user-a-2', 'assistant-a', 'user', 'project-a-second', 3)
    )}`,
    'utf8'
  )
  const refreshedA = await runHistoryProbe(agentDir, cwdA)
  assert.equal(refreshedA[0].messageCount, 3)
  assert.equal(refreshedA[0].userMessageCount, 2)
  const refreshedCatalogA = JSON.parse(await readFile(cacheA, 'utf8'))
  assert.equal(
    refreshedCatalogA.files.find((entry) => entry.record?.sessionId === 'session-a').record
      .messageCount,
    3
  )
  assert.equal(await readFile(cacheB, 'utf8'), cacheBBeforeRefresh)

  await writeFile(cacheA, '{broken cache', 'utf8')
  const recoveredA = await runHistoryProbe(agentDir, cwdA)
  assert.equal(recoveredA[0].messageCount, 3)
  assert.equal(recoveredA[0].userMessageCount, 2)
  assert.equal(JSON.parse(await readFile(cacheA, 'utf8')).version, 2)
  assert.equal(await readFile(cacheB, 'utf8'), cacheBBeforeRefresh)
})

test('迁移旧版全局缓存后删除旧文件，并在重启后复用项目分片', async (context) => {
  const { agentDir, testRoot } = await createIsolatedAgent(context)
  const cwd = join(testRoot, 'legacy-project')
  await mkdir(cwd)
  const sessionFile = await createSessionFile(agentDir, cwd, {
    fileName: 'legacy-session.jsonl',
    sessionId: 'legacy-session',
    messages: [
      { id: 'user-legacy', role: 'user', text: 'source-jsonl-value' },
      { id: 'assistant-empty', role: 'assistant', text: '' },
      { id: 'assistant-whitespace', role: 'assistant', text: '   ' }
    ]
  })
  const fileStat = await stat(sessionFile)
  const legacyPath = join(agentDir, 'pi-desk', 'pi-session-history.json')
  await mkdir(join(agentDir, 'pi-desk'), { recursive: true })
  await writeFile(
    legacyPath,
    JSON.stringify({
      version: 1,
      catalogs: [
        {
          cwd: resolve(cwd),
          files: [
            {
              descriptor: {
                path: sessionFile,
                size: fileStat.size,
                modifiedAt: fileStat.mtime.getTime()
              },
              record: {
                path: sessionFile,
                sessionId: 'legacy-session',
                cwd: resolve(cwd),
                name: null,
                createdAt: Date.parse('2026-01-01T00:00:00.000Z'),
                updatedAt: fileStat.mtime.getTime(),
                messageCount: 3,
                userMessageCount: 1,
                firstMessage: 'legacy-cache-reused',
                userMessages: [
                  {
                    entryId: 'user-legacy',
                    timestampMs: Date.parse('2026-01-01T00:00:01.000Z'),
                    text: 'legacy-cache-reused'
                  }
                ],
                assistantMessages: [
                  {
                    entryId: 'assistant-empty',
                    timestampMs: Date.parse('2026-01-01T00:00:02.000Z'),
                    text: ''
                  },
                  {
                    entryId: 'assistant-whitespace',
                    timestampMs: Date.parse('2026-01-01T00:00:03.000Z'),
                    text: '   '
                  }
                ],
                textBytes:
                  Buffer.byteLength('legacy-cache-reused', 'utf8') +
                  Buffer.byteLength('   ', 'utf8')
              }
            }
          ]
        }
      ]
    }),
    'utf8'
  )

  const migrated = await runHistoryProbe(agentDir, cwd)
  assert.equal(migrated[0].firstMessage, 'legacy-cache-reused')
  assert.equal(migrated[0].messageCount, 3)
  await assert.rejects(readFile(legacyPath), { code: 'ENOENT' })
  const cachePath = persistedCatalogPath(agentDir, cwd)
  const migratedCatalog = JSON.parse(await readFile(cachePath, 'utf8'))
  const migratedRecord = migratedCatalog.files.find(
    (entry) => entry.record?.sessionId === 'legacy-session'
  ).record
  assert.equal(migratedCatalog.version, 2)
  assert.deepEqual(migratedRecord.assistantMessages, [])
  assert.equal(migratedRecord.textBytes, Buffer.byteLength('legacy-cache-reused', 'utf8'))
  assert.equal(migratedRecord.messageCount, 3)

  const restarted = await runHistoryProbe(agentDir, cwd)
  assert.equal(restarted[0].firstMessage, 'legacy-cache-reused')
  assert.equal(restarted[0].messageCount, 3)
})

test('空 Assistant 文本不进入持久缓存，空 User 文本仍分页且消息计数不变', async (context) => {
  const { agentDir, testRoot } = await createIsolatedAgent(context)
  const cwd = join(testRoot, 'empty-message-project')
  await mkdir(cwd)
  await createSessionFile(agentDir, cwd, {
    fileName: 'empty-messages.jsonl',
    sessionId: 'empty-messages',
    messages: [
      { id: 'user-empty', role: 'user', text: '' },
      { id: 'assistant-empty', role: 'assistant', text: '' },
      { id: 'user-visible', role: 'user', text: 'visible user text' },
      { id: 'assistant-whitespace', role: 'assistant', text: '   ' }
    ]
  })

  prepareHistoryProbe(agentDir)
  const sessions = await listL4PiSessionHistory(cwd)
  assert.equal(sessions[0].messageCount, 4)
  assert.equal(sessions[0].userMessageCount, 2)
  assert.equal(sessions[0].firstMessage, 'visible user text')

  const page = await listL4PiSessionUserMessages({
    cwd,
    sessionId: 'empty-messages',
    query: '',
    page: { index: 1, size: 10 }
  })
  assert.equal(page.page.total, 2)
  assert.deepEqual(
    page.messages.map((message) => message.text),
    ['visible user text', '']
  )

  const catalog = JSON.parse(await readFile(persistedCatalogPath(agentDir, cwd), 'utf8'))
  const record = catalog.files.find((entry) => entry.record?.sessionId === 'empty-messages').record
  assert.deepEqual(record.assistantMessages, [])
  assert.equal(record.textBytes, Buffer.byteLength('visible user text', 'utf8'))
})

function observeTranscriptReads(context) {
  const reads = context.mock.method(fs, 'createReadStream')
  syncBuiltinESMExports()
  context.after(() => {
    reads.mock.restore()
    syncBuiltinESMExports()
  })
  return reads
}

test('手动刷新只读取新增或变化会话，未变化文件继续复用投影', async (context) => {
  const { agentDir, testRoot } = await createIsolatedAgent(context)
  const cwd = join(testRoot, 'refresh-project')
  const first = await createSessionFile(agentDir, cwd, {
    fileName: 'first.jsonl',
    sessionId: 'first',
    messages: [{ id: 'user-first', role: 'user', text: 'first' }]
  })
  const second = await createSessionFile(agentDir, cwd, {
    fileName: 'second.jsonl',
    sessionId: 'second',
    messages: [{ id: 'user-second', role: 'user', text: 'second' }]
  })
  await runHistoryProbe(agentDir, cwd)
  const reads = observeTranscriptReads(context)
  await listL4PiSessionHistory(cwd, '', true)
  assert.equal(reads.mock.calls.length, 0)
  await writeFile(
    first,
    `${await readFile(first, 'utf8')}${sessionLine(messageEntry('new-user', 'user-first', 'user', 'changed', 4))}`
  )
  await rm(second)
  const result = await listL4PiSessionHistory(cwd, '', true)
  assert.deepEqual(
    reads.mock.calls.map((call) => call.arguments[0]),
    [first]
  )
  assert.equal(result.length, 1)
  assert.equal(result[0].messageCount, 2)
})

test('冷启动用户消息分页只读取目标文件，后续历史列表仍补齐其他会话', async (context) => {
  const { agentDir, testRoot } = await createIsolatedAgent(context)
  const cwd = join(testRoot, 'page-project')
  const target = await createSessionFile(agentDir, cwd, {
    fileName: 'target.jsonl',
    sessionId: 'target',
    messages: [{ id: 'user-target', role: 'user', text: 'target text' }]
  })
  const other = await createSessionFile(agentDir, cwd, {
    fileName: 'other.jsonl',
    sessionId: 'other',
    messages: [{ id: 'user-other', role: 'user', text: 'other text' }]
  })
  prepareHistoryProbe(agentDir)
  const reads = observeTranscriptReads(context)
  const input = { cwd, sessionId: 'target', query: '', page: { index: 1, size: 20 } }
  assert.equal((await listL4PiSessionUserMessages(input)).messages[0].text, 'target text')
  await listL4PiSessionUserMessages(input)
  assert.deepEqual(
    reads.mock.calls.map((call) => call.arguments[0]),
    [target]
  )
  assert.equal((await listL4PiSessionHistory(cwd)).length, 2)
  assert.deepEqual(
    reads.mock.calls.map((call) => call.arguments[0]),
    [target, other]
  )
  await writeFile(
    target,
    `${await readFile(target, 'utf8')}${sessionLine(messageEntry('new-user', 'user-target', 'user', 'new text', 4))}`
  )
  assert.equal((await listL4PiSessionUserMessages(input)).page.total, 2)
  assert.deepEqual(
    reads.mock.calls.map((call) => call.arguments[0]),
    [target, other, target]
  )
})

test('历史搜索共用匹配规则，默认用户范围、显式助手范围且不搜索工具或思考', async (context) => {
  const { agentDir, testRoot } = await createIsolatedAgent(context)
  const cwd = join(testRoot, 'scope-project')
  const path = await createSessionFile(agentDir, cwd, {
    fileName: 'scope-target.jsonl',
    sessionId: 'scope-target',
    messages: [
      { id: 'u1', role: 'user', text: '起始 ANCHOR anchor' },
      {
        id: 'a1',
        role: 'assistant',
        text: [
          { type: 'thinking', thinking: 'hidden-thinking' },
          { type: 'text', text: '助手 anchor' }
        ]
      },
      { id: 'tool', role: 'toolResult', text: 'hidden-tool' },
      { id: 'u2', role: 'user', text: '最新 anchor 片段' }
    ]
  })
  await writeFile(
    path,
    `${await readFile(path, 'utf8')}${sessionLine({
      type: 'session_info',
      id: 'title',
      parentId: 'u2',
      name: '搜索回归标题',
      timestamp: '2026-01-01T00:00:06.000Z'
    })}`
  )
  prepareHistoryProbe(agentDir)
  const defaultResults = await listL4PiSessionHistory(cwd, '  AnChOr  ')
  assert.equal(defaultResults.length, 1)
  assert.deepEqual(
    defaultResults[0].matches.map(({ scope, count, entryId }) => ({ scope, count, entryId })),
    [{ scope: 'user', count: 2, entryId: 'u2' }]
  )
  assert.match(defaultResults[0].matches[0].preview, /最新 anchor 片段/)
  const assistantResults = await listL4PiSessionHistory(cwd, 'anchor', false, ['assistant'])
  assert.deepEqual(
    assistantResults[0].matches.map(({ scope, count, entryId }) => ({ scope, count, entryId })),
    [{ scope: 'assistant', count: 1, entryId: 'a1' }]
  )
  assert.equal((await listL4PiSessionHistory(cwd, '回归标题', false, ['title'])).length, 1)
  assert.equal((await listL4PiSessionHistory(cwd, 'scope-target', false, ['sessionId'])).length, 1)
  for (const query of ['hidden-thinking', 'hidden-tool']) {
    assert.deepEqual(await listL4PiSessionHistory(cwd, query, false, ['user', 'assistant']), [])
  }
})

test('历史缓存空闲60秒主动释放，未再访问也回收，磁盘投影可复用', async (context) => {
  const { agentDir, testRoot } = await createIsolatedAgent(context)
  const cwd = join(testRoot, 'idle-project')
  await createSessionFile(agentDir, cwd, {
    fileName: 'idle.jsonl',
    sessionId: 'idle',
    messages: [{ id: 'u1', role: 'user', text: '空闲回收关键词' }]
  })
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() })
  prepareHistoryProbe(agentDir)
  await listL4PiSessionHistory(cwd, '关键词')
  const state = globalThis.__piDeskPiSessionHistoryCatalogState
  assert.equal(state.catalogs.size, 1)
  context.mock.timers.tick(59_999)
  assert.equal(state.catalogs.size, 1)
  context.mock.timers.tick(1)
  assert.equal(state.catalogs.size, 0, '无需再次查询就应清除缓存')
  assert.equal(state.cleanupTimer, null, '无缓存时不保留回收定时器')
  assert.equal(state.activeLoads.size, 0)
  const reads = observeTranscriptReads(context)
  assert.equal((await listL4PiSessionHistory(cwd, '关键词')).length, 1)
  assert.equal(reads.mock.calls.length, 0, '内存释放后仍复用有效磁盘投影')
})

test('命中使用延长自身空闲期限，不让其他目录永久驻留', async (context) => {
  const { agentDir, testRoot } = await createIsolatedAgent(context)
  const cwdA = join(testRoot, 'renew-a')
  const cwdB = join(testRoot, 'renew-b')
  for (const [cwd, id] of [
    [cwdA, 'a'],
    [cwdB, 'b']
  ]) {
    await createSessionFile(agentDir, cwd, {
      fileName: `${id}.jsonl`,
      sessionId: id,
      messages: [{ id: `u-${id}`, role: 'user', text: '续期关键词' }]
    })
  }
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() })
  prepareHistoryProbe(agentDir)
  await listL4PiSessionHistory(cwdA)
  await listL4PiSessionHistory(cwdB)
  const state = globalThis.__piDeskPiSessionHistoryCatalogState
  context.mock.timers.tick(30_000)
  await listL4PiSessionHistory(cwdA, '关键词')
  context.mock.timers.tick(30_000)
  assert.equal(state.catalogs.has(resolve(cwdA)), true)
  assert.equal(state.catalogs.has(resolve(cwdB)), false)
  context.mock.timers.tick(30_000)
  assert.equal(state.catalogs.size, 0)
  assert.equal(state.cleanupTimer, null)
})
