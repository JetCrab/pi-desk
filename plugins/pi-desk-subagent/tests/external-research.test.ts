import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import {
  __test__,
  ensureCachedRepository,
  extractReadableText,
  ResearchCache
} from '../src/external-research'

type CacheJsonWriter = {
  writeJson(path: string, value: unknown): Promise<void>
}

function observeIndexWrites(cache: ResearchCache): string[] {
  const target = cache as unknown as CacheJsonWriter
  const originalWriteJson = target.writeJson.bind(cache)
  const indexWrites: string[] = []
  target.writeJson = async (path, value) => {
    if (path === join(cache.root, 'index.json')) indexWrites.push(path)
    await originalWriteJson(path, value)
  }
  return indexWrites
}

async function withTemporaryProject(
  run: (cwd: string, clock: { now: number }) => Promise<void>
): Promise<void> {
  const cwd = await mkdtemp(join(tmpdir(), `task-subagent-research-${process.pid}-`))
  const clock = { now: Date.parse('2026-01-01T00:00:00.000Z') }
  let runError: unknown
  try {
    await run(cwd, clock)
  } catch (error) {
    runError = error
  }
  try {
    await rm(cwd, { recursive: true, force: true })
  } catch (cleanupError) {
    if (runError !== undefined) {
      console.error('缓存测试主体错误', runError)
      console.error('缓存测试清理错误', cleanupError)
      throw new AggregateError(
        [runError, cleanupError],
        `缓存测试与清理均失败：${String(runError)}；${String(cleanupError)}`
      )
    }
    throw cleanupError
  }
  if (runError !== undefined) throw runError
}

test('研究缓存以稳定键保存、覆盖并回读证据', async () => {
  await withTemporaryProject(async (cwd, clock) => {
    const cache = new ResearchCache({ cwd, now: () => clock.now })
    const first = await cache.put({
      key: 'page:example',
      kind: 'page',
      source: 'https://example.com',
      data: { content: 'first evidence' }
    })
    const hit = await cache.get('page:example')

    assert.equal((hit?.record.data as { content: string }).content, 'first evidence')
    assert.equal(hit?.entry.contentHash, first.entry.contentHash)

    clock.now += 1_000
    const replaced = await cache.put({
      key: 'page:example',
      kind: 'page',
      source: 'https://example.com',
      data: { content: 'refreshed evidence' }
    })
    const refreshed = await cache.get('page:example')

    assert.equal((refreshed?.record.data as { content: string }).content, 'refreshed evidence')
    assert.notEqual(replaced.entry.contentHash, first.entry.contentHash)
  })
})

test('研究缓存清理七天未使用的记录', async () => {
  await withTemporaryProject(async (cwd, clock) => {
    const cache = new ResearchCache({ cwd, now: () => clock.now })
    const key = 'web-search:old'
    await cache.put({
      key,
      kind: 'web-search',
      source: 'AnySearch: old',
      data: { results: [] }
    })

    const recordPath = join(cache.root, 'records', `${__test__.hashText(key).slice(7)}.json`)
    clock.now += 7 * 24 * 60 * 60 * 1_000
    await cache.cleanup()
    await access(recordPath)

    clock.now += 1
    await cache.cleanup()
    assert.equal(await cache.get(key), undefined)
    await assert.rejects(access(recordPath))
  })
})

test('get 与 put 并发时索引和全部证据保持完整', async () => {
  await withTemporaryProject(async (cwd, clock) => {
    const cache = new ResearchCache({ cwd, now: () => clock.now })
    await cache.put({
      key: 'page:seed',
      kind: 'page',
      source: 'https://example.com/seed',
      data: { content: 'seed evidence' }
    })
    const keys = Array.from({ length: 20 }, (_, index) => `page:${index}`)
    const seedReads: Array<ReturnType<typeof cache.get>> = []
    const operations = Array.from({ length: keys.length * 2 }, (_, operationIndex) => {
      if (operationIndex % 2 === 0) {
        const read = cache.get('page:seed')
        seedReads.push(read)
        return read
      }
      const entryIndex = (operationIndex - 1) / 2
      return cache.put({
        key: keys[entryIndex]!,
        kind: 'page',
        source: `https://example.com/${entryIndex}`,
        data: { content: `evidence-${entryIndex}` }
      })
    })
    const results = await Promise.allSettled(operations)
    for (const result of results) {
      if (result.status === 'rejected') throw result.reason
    }
    assert.equal((await Promise.all(seedReads)).filter(Boolean).length, keys.length)

    const records = await Promise.all(keys.map((key) => cache.get(key)))
    assert.deepEqual(
      records.map((record) => (record?.record.data as { content: string }).content),
      keys.map((_key, index) => `evidence-${index}`)
    )
    const seed = await cache.get('page:seed')
    assert.deepEqual(seed?.record.data, { content: 'seed evidence' })
  })
})

test('缓存 get 与 put 每次只写索引一次', async () => {
  await withTemporaryProject(async (cwd, clock) => {
    const cache = new ResearchCache({ cwd, now: () => clock.now })
    const indexPath = join(cache.root, 'index.json')
    const writes = observeIndexWrites(cache)
    const assertSingleIndexWrite = () => {
      assert.deepEqual(writes, [indexPath])
      writes.length = 0
    }

    await cache.put({
      key: 'page:write-count',
      kind: 'page',
      source: 'https://example.com/write-count',
      data: { content: 'cached evidence' }
    })
    assertSingleIndexWrite()
    assert.ok(await cache.get('page:write-count'))
    assertSingleIndexWrite()
    assert.equal(await cache.get('page:missing'), undefined)
    assertSingleIndexWrite()
    await cache.put({
      key: 'page:write-count-next',
      kind: 'page',
      source: 'https://example.com/write-count-next',
      data: { content: 'next evidence' }
    })
    assertSingleIndexWrite()
  })
})

test('缺失或损坏记录会剔除索引，损坏索引可重建', async () => {
  await withTemporaryProject(async (cwd, clock) => {
    const cache = new ResearchCache({ cwd, now: () => clock.now })
    const missingKey = 'page:missing-record'
    await cache.put({
      key: missingKey,
      kind: 'page',
      source: 'https://example.com/missing-record',
      data: { content: 'missing evidence' }
    })
    const missingPath = join(
      cache.root,
      'records',
      `${__test__.hashText(missingKey).slice(7)}.json`
    )
    await rm(missingPath)
    assert.equal(await cache.get(missingKey), undefined)
    const indexPath = join(cache.root, 'index.json')
    const withoutMissing = JSON.parse(await readFile(indexPath, 'utf8')) as {
      entries: Array<{ key: string }>
    }
    assert.equal(
      withoutMissing.entries.some((entry) => entry.key === missingKey),
      false
    )

    const corruptKey = 'page:corrupt-record'
    await cache.put({
      key: corruptKey,
      kind: 'page',
      source: 'https://example.com/corrupt-record',
      data: { content: 'corrupt evidence' }
    })
    const corruptPath = join(
      cache.root,
      'records',
      `${__test__.hashText(corruptKey).slice(7)}.json`
    )
    await writeFile(corruptPath, '{broken', 'utf8')
    assert.equal(await cache.get(corruptKey), undefined)
    const withoutCorrupt = JSON.parse(await readFile(indexPath, 'utf8')) as {
      entries: Array<{ key: string }>
    }
    assert.equal(
      withoutCorrupt.entries.some((entry) => entry.key === corruptKey),
      false
    )

    await writeFile(indexPath, '{broken', 'utf8')
    assert.equal(await cache.get(missingKey), undefined)
    const rebuiltIndex = JSON.parse(await readFile(indexPath, 'utf8')) as {
      entries: unknown[]
    }
    assert.deepEqual(rebuiltIndex.entries, [])

    await cache.put({
      key: 'page:after-rebuild',
      kind: 'page',
      source: 'https://example.com/after-rebuild',
      data: { content: 'restored evidence' }
    })
    assert.equal(
      ((await cache.get('page:after-rebuild'))?.record.data as { content: string }).content,
      'restored evidence'
    )
  })
})

test('指定 Git ref 首次 clone 后会 checkout 独立工作树', async () => {
  await withTemporaryProject(async (cwd) => {
    const cache = new ResearchCache({ cwd })
    const calls: Array<{ command: string; args: string[] }> = []
    const worktrees = new Set<string>()
    let pendingCommit = 'default-commit'
    let currentCommit = 'default-commit'
    const pi = {
      exec: async (command: string, args: string[]) => {
        calls.push({ command, args })
        if (command === 'gh' && args[0] === 'repo' && args[1] === 'clone') {
          const localPath = args[3]
          await mkdir(join(localPath, '.git'), { recursive: true })
          worktrees.add(localPath)
          return { code: 0, stdout: '', stderr: '' }
        }
        if (command === 'git' && args.includes('--is-inside-work-tree')) {
          return {
            code: worktrees.has(args[1]) ? 0 : 1,
            stdout: worktrees.has(args[1]) ? 'true\n' : '',
            stderr: ''
          }
        }
        if (command === 'git' && args.includes('fetch')) {
          pendingCommit = args.at(-1) === 'release' ? 'release-commit' : 'default-commit'
          return { code: 0, stdout: '', stderr: '' }
        }
        if (command === 'git' && args.includes('checkout')) {
          currentCommit = pendingCommit
          return { code: 0, stdout: '', stderr: '' }
        }
        if (command === 'git' && args.includes('rev-parse')) {
          return { code: 0, stdout: `${currentCommit}\n`, stderr: '' }
        }
        return { code: 0, stdout: '', stderr: '' }
      }
    } as unknown as ExtensionAPI

    const [first, second] = await Promise.all([
      ensureCachedRepository({
        pi,
        cache,
        cwd,
        repository: 'owner/repo',
        ref: 'release',
        refresh: false
      }),
      ensureCachedRepository({
        pi,
        cache,
        cwd,
        repository: 'owner/repo',
        ref: 'release',
        refresh: false
      })
    ])
    const release = first.cached.record.data as {
      ref: string | null
      commit: string
      localPath: string
    }
    assert.equal(first.cacheStatus, 'miss')
    assert.equal(second.cacheStatus, 'hit')
    assert.equal(release.ref, 'release')
    assert.equal(release.commit, 'release-commit')
    assert.equal(
      calls.filter((call) => call.command === 'gh' && call.args[1] === 'clone').length,
      1
    )
    assert.ok(
      calls.some(
        (call) =>
          call.command === 'git' && call.args.includes('fetch') && call.args.at(-1) === 'release'
      )
    )
    assert.ok(calls.some((call) => call.command === 'git' && call.args.includes('checkout')))

    const main = await ensureCachedRepository({
      pi,
      cache,
      cwd,
      repository: 'owner/repo',
      refresh: false
    })
    const defaultBranch = main.cached.record.data as { localPath: string }
    assert.notEqual(defaultBranch.localPath, release.localPath)
  })
})

test('网页正文提取移除脚本并保留可引用段落', () => {
  const text = extractReadableText(`
    <html><head><title>ignored</title><script>window.secret = "hidden";</script></head>
    <body><article><h1>Evidence title</h1><p>First paragraph.</p><p>Second &amp; final paragraph.</p></article></body></html>
  `)

  assert.match(text, /Evidence title\nFirst paragraph\.\nSecond & final paragraph\./)
  assert.doesNotMatch(text, /window\.secret/)
})
