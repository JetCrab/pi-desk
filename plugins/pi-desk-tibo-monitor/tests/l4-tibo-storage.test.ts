import assert from 'node:assert/strict'
import { lstat, mkdtemp, readFile, readdir, rm, stat, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { defaultSettings, type TiboRecord, type TiboStored } from '../src/l4-tibo-protocol.js'
import { readStore, retainRecords, writeStore } from '../src/l4-tibo-storage.js'

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
  const root = await mkdtemp(join(tmpdir(), 'tibo-storage-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  return { root, path: join(root, 'state.json') }
}

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
  const { path } = await tempFile(context)
  await writeFile(path, '')
  await truncate(path, 64 * 1024 * 1024 + 1)

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
