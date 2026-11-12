import assert from 'node:assert/strict'
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'
import { mkdir, mkdtemp, open, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { gzipSync, gunzipSync } from 'node:zlib'
import { pack, type Header } from 'tar-stream'
import {
  readEnvironmentArchive,
  writeEnvironmentArchive,
  type EnvironmentArchiveEntry,
  type EnvironmentArchiveLimits
} from '../src/server/l4_foundation/environment/l4-environment-archive.ts'

const password = 'test-only-environment-backup-password'

async function fixture(): Promise<string> {
  const base = resolve('temp/run/environment-archive')
  await mkdir(base, { recursive: true })
  const root = await mkdtemp(join(base, 'archive-security-'))
  // 本测试不加载 Pi、不访问默认 AgentDir；所有文件均为合成数据。
  await mkdir(join(root, 'agent'), { recursive: true })
  return root
}

function archiveTest(name: string, run: (root: string) => Promise<void>): void {
  test(name, async () => {
    const root = await fixture()
    try {
      await run(root)
      await rm(root, { recursive: true, force: true })
    } catch (error) {
      console.error('归档测试现场：', root)
      throw error
    }
  })
}

async function* entries(
  files: Record<string, string | Buffer>
): AsyncGenerator<EnvironmentArchiveEntry> {
  for (const [path, value] of Object.entries(files)) {
    const data = Buffer.from(value)
    yield {
      path,
      size: data.length,
      content: (async function* (): AsyncGenerator<Buffer> {
        yield data
      })()
    }
  }
}

// 独立按v1格式制作输入，避免只用被测写入器构造读取器的全部预期。
function encryptTar(tar: Buffer): Buffer {
  const header = Buffer.alloc(68)
  header.write('PDSKBK01', 0)
  for (const [offset, value] of [
    [8, 1],
    [12, 32768],
    [16, 8],
    [20, 1]
  ])
    header.writeUInt32BE(value!, offset!)
  randomBytes(16).copy(header, 24)
  randomBytes(12).copy(header, 40)
  const key = scryptSync(password, header.subarray(24, 40), 32, {
    N: 32768,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024
  })
  const cipher = createCipheriv('aes-256-gcm', key, header.subarray(40, 52))
  cipher.setAAD(header.subarray(0, 52))
  const body = Buffer.concat([cipher.update(gzipSync(tar)), cipher.final()])
  cipher.getAuthTag().copy(header, 52)
  key.fill(0)
  return Buffer.concat([header, body])
}

async function rawTar(
  headers: Partial<Header>[],
  content = Buffer.from('fixture')
): Promise<Buffer> {
  const archive = pack()
  const collecting = (async (): Promise<Buffer> => {
    const chunks: Buffer[] = []
    for await (const chunk of archive) chunks.push(Buffer.from(chunk as Uint8Array))
    return Buffer.concat(chunks)
  })()
  for (const header of headers) {
    await new Promise<void>((resolve, reject) => {
      const type = header.type ?? 'file'
      const body = type === 'file' ? content : Buffer.alloc(0)
      archive.entry(
        { name: 'safe/file', ...header, size: body.length },
        body,
        (error?: Error | null) => {
          if (error) reject(error)
          else resolve()
        }
      )
    })
  }
  archive.finalize()
  return collecting
}

archiveTest('流式加密往返与隔离安全解包，清单也在加密tar中', async (root) => {
  const archivePath = join(root, 'backup.pdesk')
  const files = {
    'manifest.json': '{"testOnly":true}',
    'sessions/parent.jsonl': '{"type":"session","id":"test-session"}\n',
    'config/empty': ''
  }
  await writeEnvironmentArchive({ outputPath: archivePath, password, entries: entries(files) })
  const encrypted = await readFile(archivePath)
  assert.equal(encrypted.includes(Buffer.from('manifest.json')), false)
  const key = scryptSync(password, encrypted.subarray(24, 40), 32, {
    N: 32768,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024
  })
  const decipher = createDecipheriv('aes-256-gcm', key, encrypted.subarray(40, 52))
  decipher.setAAD(encrypted.subarray(0, 52))
  decipher.setAuthTag(encrypted.subarray(52, 68))
  const tar = gunzipSync(Buffer.concat([decipher.update(encrypted.subarray(68)), decipher.final()]))
  key.fill(0)
  assert.equal(tar.subarray(257, 262).toString(), 'ustar')
  assert.ok(tar.includes(Buffer.from(files['manifest.json'])))
  const staging = join(root, 'staging')
  await mkdir(staging)
  await readEnvironmentArchive({
    archivePath,
    password,
    consumeEntry: async (header, content) => {
      const target = join(staging, ...header.path.split('/'))
      await mkdir(resolve(target, '..'), { recursive: true })
      const handle = await open(target, 'wx')
      try {
        for await (const chunk of content) await handle.writeFile(chunk)
      } finally {
        await handle.close()
      }
    }
  })
  for (const [path, expected] of Object.entries(files))
    assert.equal(await readFile(join(staging, path), 'utf8'), expected)
  // 函数返回后无残留句柄，文件可立即移动/删除。
  await rename(archivePath, join(root, 'released.pdesk'))
})

archiveTest('错误密码、截断、密文或认证头篡改均在消费者之前拒绝', async (root) => {
  const originalPath = join(root, 'original')
  await writeEnvironmentArchive({
    outputPath: originalPath,
    password,
    entries: entries({ 'manifest.json': 'synthetic' })
  })
  const original = await readFile(originalPath)
  const corruptBody = Buffer.from(original)
  corruptBody[corruptBody.length - 1]! ^= 1
  const corruptTag = Buffer.from(original)
  corruptTag[52]! ^= 1
  const corruptSalt = Buffer.from(original)
  corruptSalt[24]! ^= 1
  const badKdf = Buffer.from(original)
  badKdf.writeUInt32BE(2 ** 30, 12)
  for (const [index, bytes] of [
    original,
    original.subarray(0, 32),
    original.subarray(0, original.length - 1),
    corruptBody,
    corruptTag,
    corruptSalt,
    badKdf
  ].entries()) {
    const archivePath = join(root, `invalid-${index}`)
    await writeFile(archivePath, bytes)
    let calls = 0
    await assert.rejects(
      readEnvironmentArchive({
        archivePath,
        password: index === 0 ? 'wrong-password' : password,
        consumeEntry: async () => {
          calls += 1
        }
      })
    )
    assert.equal(calls, 0)
    await rm(archivePath)
  }
})

archiveTest(
  '认证成功但包含路径攻击、链接、设备、重复或目标碰撞的tar也不调用消费者',
  async (root) => {
    const cases: Partial<Header>[][] = [
      ...[
        '../escape',
        '/absolute',
        'C:/absolute',
        'C:relative',
        'dir\\..\\escape',
        '\\\\server\\share',
        'a/../b',
        'a//b'
      ].map((name) => [{ name }]),
      ...(
        ['symlink', 'link', 'block-device', 'character-device', 'fifo', 'directory'] as const
      ).map((type) => [{ type, linkname: '../escape' }]),
      [{ name: 'same' }, { name: 'same' }],
      [{ name: 'folder/A' }, { name: 'folder/a' }],
      [{ name: 'Folder/a' }, { name: 'folder/b' }],
      [{ name: 'a' }, { name: 'a/b' }],
      [{ name: 'NUL.txt' }]
    ]
    for (const [index, headers] of cases.entries()) {
      const archivePath = join(root, `attack-${index}`)
      await writeFile(archivePath, encryptTar(await rawTar(headers)))
      let calls = 0
      await assert.rejects(
        readEnvironmentArchive({
          archivePath,
          password,
          limits: { targetPlatform: 'win32' },
          consumeEntry: async () => {
            calls += 1
          }
        }),
        `attack ${index}`
      )
      assert.equal(calls, 0, `attack ${index}`)
    }
  }
)

archiveTest('读取限制覆盖文件数、条目容量、总容量、压缩膨胀和包大小', async (root) => {
  const archivePath = join(root, 'limited')
  await writeFile(
    archivePath,
    encryptTar(await rawTar([{ name: 'a' }, { name: 'b' }], Buffer.alloc(8192)))
  )
  const cases: Partial<EnvironmentArchiveLimits>[] = [
    { maxFiles: 1 },
    { maxEntryBytes: 4096 },
    { maxTotalBytes: 8192 },
    { maxExpansionRatio: 1 },
    { maxArchiveBytes: 68 }
  ]
  for (const limits of cases) {
    let calls = 0
    await assert.rejects(
      readEnvironmentArchive({
        archivePath,
        password,
        limits,
        consumeEntry: async () => {
          calls += 1
        }
      })
    )
    assert.equal(calls, 0)
  }
})

archiveTest('写入拒绝危险路径及错误流长度，删除半包且不覆盖现有文件', async (root) => {
  for (const [index, data] of [
    [{ path: '../escape', size: 1, content: entriesContent('x') }],
    [{ path: 'safe', size: 2, content: entriesContent('x') }],
    [{ path: 'safe', size: 1, content: entriesContent('long') }],
    [
      { path: 'a', size: 1, content: entriesContent('a') },
      { path: 'a/b', size: 1, content: entriesContent('b') }
    ]
  ].entries()) {
    const outputPath = join(root, `partial-${index}`)
    await assert.rejects(
      writeEnvironmentArchive({
        outputPath,
        password,
        entries: (async function* (): AsyncGenerator<EnvironmentArchiveEntry> {
          yield* data
        })()
      })
    )
    await assert.rejects(readFile(outputPath), { code: 'ENOENT' })
  }
  const outputPath = join(root, 'existing')
  await writeFile(outputPath, 'keep')
  await assert.rejects(
    writeEnvironmentArchive({ outputPath, password, entries: entries({ a: 'a' }) }),
    { code: 'EEXIST' }
  )
  assert.equal(await readFile(outputPath, 'utf8'), 'keep')
})

async function* entriesContent(text: string): AsyncGenerator<Buffer> {
  yield Buffer.from(text)
}

archiveTest('消费者失败会释放句柄；第二遍原地篡改使整个暂存结果失败', async (root) => {
  const archivePath = join(root, 'mutable')
  await writeEnvironmentArchive({
    outputPath: archivePath,
    password,
    entries: entries({ first: 'first', tail: randomBytes(1024 * 1024) })
  })
  await assert.rejects(
    readEnvironmentArchive({
      archivePath,
      password,
      consumeEntry: async () => {
        throw new Error('consumer-failed')
      }
    }),
    /consumer-failed/
  )
  let calls = 0
  await assert.rejects(
    readEnvironmentArchive({
      archivePath,
      password,
      consumeEntry: async (_header, content) => {
        calls += 1
        if (calls === 1) {
          const handle = await open(archivePath, 'r+')
          try {
            const { size } = await handle.stat()
            const byte = Buffer.alloc(1)
            await handle.read(byte, 0, 1, size - 1)
            byte[0]! ^= 1
            await handle.write(byte, 0, 1, size - 1)
          } finally {
            await handle.close()
          }
        }
        for await (const chunk of content) void chunk
      }
    })
  )
  assert.ok(calls > 0)
  await rm(archivePath)
})

archiveTest('路径替换不改变两遍读取所持有的文件句柄', async (root) => {
  const archivePath = join(root, 'controlled')
  const original = join(root, 'original-inode')
  await writeEnvironmentArchive({
    outputPath: archivePath,
    password,
    entries: entries({ original: 'source-data' })
  })
  let actual = ''
  await readEnvironmentArchive({
    archivePath,
    password,
    consumeEntry: async (_header, content) => {
      await rename(archivePath, original)
      await writeFile(archivePath, 'replacement-not-an-archive')
      for await (const chunk of content) actual += chunk.toString()
    }
  })
  assert.equal(actual, 'source-data')
  assert.equal(await readFile(archivePath, 'utf8'), 'replacement-not-an-archive')
})
