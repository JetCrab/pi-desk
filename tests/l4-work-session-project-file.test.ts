import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import sharp from 'sharp'
import {
  L2WorkSessionFileGetRequestSchema,
  L2WorkSessionFileListRequestSchema,
  L2WorkSessionFileRevealRequestSchema
} from '../src/common/l2_biz/work-session/l2-work-session-file-contract'
import {
  L4WorkSessionProjectFileError,
  getL4WorkSessionProjectFile,
  listL4WorkSessionProjectFiles,
  revealL4WorkSessionProjectFile,
  searchL4WorkSessionProjectFiles
} from '../src/server/l4_foundation/file/l4-work-session-project-file'

async function fixture(context: test.TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'pi-desk-project-files-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'src'), { recursive: true })
  await mkdir(join(root, 'temp'), { recursive: true })
  await mkdir(join(root, '.git'), { recursive: true })
  await mkdir(join(root, 'node_modules'), { recursive: true })
  await writeFile(join(root, 'README.md'), '# Pi Desk\n')
  await writeFile(join(root, 'src', 'workbench.ts'), 'export const workbench = true\n')
  await writeFile(join(root, 'temp', 'debug.txt'), 'debug\n')
  await writeFile(join(root, '.git', 'config'), 'hidden\n')
  await writeFile(join(root, 'node_modules', 'hidden.js'), 'hidden\n')
  return root
}

test('目录浏览仍拒绝越界，文件预览允许绝对路径', () => {
  assert.equal(
    L2WorkSessionFileListRequestSchema.safeParse({
      workId: 'work-1',
      cwd: 'C:/project',
      path: '../outside'
    }).success,
    false
  )
  assert.equal(
    L2WorkSessionFileGetRequestSchema.safeParse({
      workId: 'work-1',
      cwd: 'C:/project',
      path: 'C:/outside.txt',
      imagePreviewMode: 'compressed'
    }).success,
    true
  )
  assert.equal(
    L2WorkSessionFileRevealRequestSchema.safeParse({
      workId: 'work-1',
      cwd: 'C:/project',
      path: 'C:/outside.txt'
    }).success,
    false
  )
})

test('同一root复用搜索索引，显式目录刷新后重新读取文件', async (context) => {
  const root = await fixture(context)
  assert.deepEqual((await searchL4WorkSessionProjectFiles(root, 'added-later')).matches, [])

  await writeFile(join(root, 'added-later.txt'), 'new file\n')
  assert.deepEqual((await searchL4WorkSessionProjectFiles(root, 'added-later')).matches, [])

  await listL4WorkSessionProjectFiles(root, '')
  assert.deepEqual((await searchL4WorkSessionProjectFiles(root, 'added-later')).matches, [
    'added-later.txt'
  ])
})

test('搜索目录缓存超过20个cwd后淘汰最早索引', async (context) => {
  const testRoot = join(
    process.cwd(),
    'temp/tests/l4-work-session-project-file',
    `search-capacity-${process.pid}`
  )
  await mkdir(testRoot, { recursive: true })
  context.after(() => rm(testRoot, { recursive: true, force: true }))
  const roots: string[] = []

  for (let index = 0; index < 21; index += 1) {
    const root = join(testRoot, `cwd-${index}`)
    roots.push(root)
    execFileSync('git', ['init', '--quiet', root], { windowsHide: true })
    await writeFile(join(root, 'indexed.marker'), 'indexed\n')
    assert.deepEqual((await searchL4WorkSessionProjectFiles(root, 'indexed.marker')).matches, [
      'indexed.marker'
    ])
  }

  await writeFile(join(roots[0]!, 'after-eviction.marker'), 'fresh\n')
  assert.deepEqual((await searchL4WorkSessionProjectFiles(roots[0]!, 'after-eviction')).matches, [
    'after-eviction.marker'
  ])
})

test('目录列表过滤重型目录但保留 temp', async (context) => {
  const root = await fixture(context)
  const result = await listL4WorkSessionProjectFiles(root, '')

  assert.deepEqual(
    result.entries.map((entry) => entry.name),
    ['src', 'temp', 'README.md']
  )
  assert.equal(result.truncated, false)
})

test('搜索文件名和相对路径且跳过重型目录', async (context) => {
  const root = await fixture(context)
  const result = await searchL4WorkSessionProjectFiles(root, 'workbench')

  assert.deepEqual(result.matches, ['src/workbench.ts'])
  assert.equal(result.truncated, false)
})

test('在系统文件管理器定位现有文件，缺失文件回退打开父目录', async (context) => {
  const root = await fixture(context)
  const calls: Array<{ command: string; args: string[] }> = []
  const run = async (command: string, args: string[]): Promise<void> => {
    calls.push({ command, args })
  }

  await revealL4WorkSessionProjectFile(root, 'README.md', run)
  await revealL4WorkSessionProjectFile(root, 'removed.txt', run)

  if (process.platform === 'win32') {
    assert.equal(calls[0]?.command, 'explorer.exe')
    assert.equal(calls[0]?.args[0], '/select,')
    assert.equal(calls[0]?.args[1]?.endsWith('README.md'), true)
    assert.deepEqual(calls[1], { command: 'explorer.exe', args: [root] })
  } else if (process.platform === 'darwin') {
    assert.equal(calls[0]?.command, 'open')
    assert.equal(calls[0]?.args[0], '-R')
    assert.equal(calls[0]?.args[1]?.endsWith('README.md'), true)
    assert.deepEqual(calls[1], { command: 'open', args: [root] })
  } else {
    assert.deepEqual(calls, [
      { command: 'xdg-open', args: [root] },
      { command: 'xdg-open', args: [root] }
    ])
  }

  await assert.rejects(
    () => revealL4WorkSessionProjectFile(root, '../outside.txt', run),
    (error: unknown) =>
      error instanceof L4WorkSessionProjectFileError && error.kind === 'outside-project'
  )
  await assert.rejects(
    () =>
      revealL4WorkSessionProjectFile(root, 'README.md', async () => {
        throw new Error('failed')
      }),
    (error: unknown) =>
      error instanceof L4WorkSessionProjectFileError && error.kind === 'reveal-failed'
  )
})

test('读取 UTF-8 文本并拒绝越界和超大文本', async (context) => {
  const root = await fixture(context)
  const text = await getL4WorkSessionProjectFile(root, 'README.md', 'compressed')
  assert.deepEqual(text, { kind: 'text', content: '# Pi Desk\n', size: 10 })

  await assert.rejects(
    () => getL4WorkSessionProjectFile(root, '../outside.txt', 'compressed'),
    (error: unknown) =>
      error instanceof L4WorkSessionProjectFileError && error.kind === 'outside-project'
  )

  await writeFile(join(root, 'large.txt'), Buffer.alloc(5 * 1024 * 1024 + 1, 0x61))
  await assert.rejects(
    () => getL4WorkSessionProjectFile(root, 'large.txt', 'compressed'),
    (error: unknown) =>
      error instanceof L4WorkSessionProjectFileError && error.kind === 'text-too-large'
  )
})

test('绝对路径可预览 WorkSession 项目外文件', async (context) => {
  const root = await fixture(context)
  const externalDirectory = await mkdtemp(join(tmpdir(), 'pi-desk-external-preview-'))
  context.after(() => rm(externalDirectory, { recursive: true, force: true }))
  const externalPath = join(externalDirectory, 'session.jsonl')
  await writeFile(externalPath, '{"type":"session"}\n')

  const result = await getL4WorkSessionProjectFile(root, externalPath, 'compressed')

  assert.deepEqual(result, {
    kind: 'text',
    content: '{"type":"session"}\n',
    size: 19
  })
})

test('压缩预览输出较小 WebP，原图预览保持 JPEG', async (context) => {
  const root = await fixture(context)
  const width = 1400
  const height = 900
  const original = await sharp(randomBytes(width * height * 3), {
    raw: { width, height, channels: 3 }
  })
    .jpeg({ quality: 96 })
    .toBuffer()
  assert.ok(original.length > 512 * 1024)
  await writeFile(join(root, 'photo.jpg'), original)

  const compressed = await getL4WorkSessionProjectFile(root, 'photo.jpg', 'compressed')
  assert.equal(compressed.kind, 'image')
  if (compressed.kind !== 'image') return
  assert.equal(compressed.mimeType, 'image/webp')
  assert.ok(compressed.size < original.length)

  const uncompressed = await getL4WorkSessionProjectFile(root, 'photo.jpg', 'original')
  assert.equal(uncompressed.kind, 'image')
  if (uncompressed.kind !== 'image') return
  assert.equal(uncompressed.mimeType, 'image/jpeg')
  assert.equal(uncompressed.size, original.length)
})

test('压缩超长截图时不因高度超过 2560 而缩小宽度', async (context) => {
  const root = await fixture(context)
  const width = 390
  const height = 4000
  const original = await sharp(randomBytes(width * height), {
    raw: { width, height, channels: 1 }
  })
    .png()
    .toBuffer()
  assert.ok(original.length > 512 * 1024)
  await writeFile(join(root, 'long-screenshot.png'), original)

  const compressed = await getL4WorkSessionProjectFile(root, 'long-screenshot.png', 'compressed')
  assert.equal(compressed.kind, 'image')
  if (compressed.kind !== 'image') return
  assert.equal(compressed.mimeType, 'image/webp')

  const metadata = await sharp(Buffer.from(compressed.data, 'base64')).metadata()
  assert.equal(metadata.width, width)
  assert.equal(metadata.height, height)
})
