import assert from 'node:assert/strict'
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  truncate,
  writeFile
} from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'
import { bindConfigStore, getUnifiedConfigPath } from '@jetcrab/pi-desk-sdk/config'
import test from 'node:test'
import { defaultSettings, type TiboRecord, type TiboStored } from '../src/l4-tibo-protocol.js'
import {
  defaultTiboStorePaths,
  readStore as readConfigStore,
  retainRecords,
  writeStore as writeConfigStore
} from '../src/l4-tibo-storage.js'

function store(path: string) {
  return bindConfigStore('plugins', 'tibo-monitor', { agentDir: dirname(dirname(path)) })
}

function readStore(
  path: string,
  dataPath = join(dirname(dirname(path)), 'pi-desk', 'tibo-monitor.json')
) {
  return readConfigStore(store(path), dataPath)
}

function writeStore(
  path: string,
  value: TiboStored,
  dataPath = join(dirname(dirname(path)), 'pi-desk', 'tibo-monitor.json')
) {
  return writeConfigStore(store(path), value, dataPath)
}

function record(id: string, publishedAt: number): TiboRecord {
  return {
    id,
    title: id,
    text: `正文-${id}`,
    link: `https://x.com/alice/status/${publishedAt}`,
    publishedAt,
    analysis: null
  }
}

async function tempFile(context: test.TestContext): Promise<{ root: string; path: string }> {
  const runs = fileURLToPath(new URL('../../../temp/run/tibo-storage/', import.meta.url))
  await mkdir(runs, { recursive: true })
  const root = await mkdtemp(join(runs, 'config-and-data-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'config'), { recursive: true })
  return { root, path: getUnifiedConfigPath(root) }
}

test('只读写最新分离文件且旧混合配置保持原字节', async (context) => {
  const { root } = await tempFile(context)
  const previous = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = root
  context.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previous
  })
  const legacy = join(root, 'pi-desk-tibo-monitor.json')
  const original: TiboStored = {
    settings: defaultSettings(),
    records: [record('kept', 10)],
    analysisRegion: { locale: 'en', timeZone: 'UTC' }
  }
  const older = join(root, 'pi-super-tibo-monitor.json')
  const oldContent = '{旧混合配置不应解析}'
  await writeFile(legacy, oldContent)
  await writeFile(older, oldContent)
  const { dataPath } = defaultTiboStorePaths()
  const path = getUnifiedConfigPath(root)
  assert.deepEqual(await readStore(path, dataPath), { settings: defaultSettings(), records: [] })
  await writeStore(path, original, dataPath)
  assert.equal(path, join(root, 'config', 'pi-desk.yaml'))
  assert.equal(dataPath, join(root, 'pi-desk', 'tibo-monitor.json'))
  assert.deepEqual(await readStore(path, dataPath), original)
  assert.deepEqual(parseYaml(await readFile(path, 'utf8')).plugins['tibo-monitor'], {
    settings: original.settings
  })
  const data = JSON.parse(await readFile(dataPath, 'utf8'))
  assert.equal(data.settings, undefined)
  assert.deepEqual(data.records, original.records)
  assert.equal(await readFile(legacy, 'utf8'), oldContent)
  assert.equal(await readFile(older, 'utf8'), oldContent)
  const next = { ...original, settings: { ...original.settings, intervalSeconds: 120 } }
  await writeStore(path, next, dataPath)
  defaultTiboStorePaths()
  assert.deepEqual(await readStore(path, dataPath), next)
})

test('最新设置和业务文件拒绝混合字段且读取不改写', async (context) => {
  const { root, path } = await tempFile(context)
  const mixed = JSON.stringify({ settings: defaultSettings(), records: [] })
  await store(path).set({ settings: defaultSettings(), records: [] })
  const before = await readFile(path, 'utf8')
  await assert.rejects(readStore(path), /Unrecognized key/)
  assert.equal(await readFile(path, 'utf8'), before)
  await store(path).set({ settings: defaultSettings() })
  const dataPath = join(root, 'pi-desk', 'tibo-monitor.json')
  await mkdir(join(root, 'pi-desk'), { recursive: true })
  await writeFile(dataPath, mixed)
  await assert.rejects(readStore(path), /Unrecognized key/)
  assert.equal(await readFile(dataPath, 'utf8'), mixed)
})

test('retainRecords按ID去重、发布时间倒序并应用保留上限', () => {
  const records = [record('old', 1), record('new', 3), record('new', 2), record('middle', 2)]

  assert.deepEqual(
    retainRecords(records, 2).map((item) => item.id),
    ['new', 'middle']
  )
})

test('存储首次读取使用默认设置，写入后保持受限记录集合', async (context) => {
  const { path } = await tempFile(context)
  const settings = { ...defaultSettings(), retentionCount: 10 }
  const value: TiboStored = {
    settings,
    records: Array.from({ length: 12 }, (_, index) => record(`post-${index}`, index))
  }

  assert.deepEqual(await readStore(path), { settings: defaultSettings(), records: [] })
  await writeStore(path, value)
  const stored = await readStore(path)

  assert.equal(stored.records.length, 10)
  assert.deepEqual(
    stored.records.map((item) => item.id),
    [
      'post-11',
      'post-10',
      'post-9',
      'post-8',
      'post-7',
      'post-6',
      'post-5',
      'post-4',
      'post-3',
      'post-2'
    ]
  )
  assert.equal((await stat(path)).isFile(), true)
})

test('写入使用临时文件替换，成功后不遗留临时文件且文件始终可解析', async (context) => {
  const { root, path } = await tempFile(context)
  await writeStore(path, { settings: defaultSettings(), records: [record('first', 1)] })
  await writeStore(path, { settings: defaultSettings(), records: [record('second', 2)] })

  assert.equal((await readStore(path)).records[0]?.id, 'second')
  assert.deepEqual(
    (await readdir(root)).filter((name) => name.endsWith('.tmp')),
    []
  )
  assert.equal((await readFile(path, 'utf8')).endsWith('\n'), true)
})

test('读取实际超过64MB的文件时在JSON解析前拒绝', async (context) => {
  const { root, path } = await tempFile(context)
  await writeStore(path, { settings: defaultSettings(), records: [] })
  await truncate(join(root, 'pi-desk', 'tibo-monitor.json'), 64 * 1024 * 1024 + 1)

  await assert.rejects(readStore(path), /超过容量限制/)
})

test('写入失败不会覆盖既有有效文件', async (context) => {
  const { path } = await tempFile(context)
  await writeStore(path, { settings: defaultSettings(), records: [record('kept', 1)] })

  await assert.rejects(
    writeStore(path, {
      settings: { ...defaultSettings(), retentionCount: 10 },
      records: [
        {
          ...record('invalid', 2),
          title: ''
        } as TiboRecord
      ]
    }),
    /Too small|不能为空|String must contain/i
  )
  assert.equal((await readStore(path)).records[0]?.id, 'kept')

  const info = await lstat(path)
  assert.equal(info.isFile(), true)
})
