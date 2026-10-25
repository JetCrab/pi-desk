import assert from 'node:assert/strict'
import childProcess, { execFileSync } from 'node:child_process'
import { EventEmitter, getEventListeners } from 'node:events'
import fsPromises, { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { dirname, join } from 'node:path'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import {
  L4ProjectFileSearchSchema,
  L4ProjectSearchInputSchema,
  type L4ProjectSearchInput
} from '../src/common/l4_foundation/file/l4-project-file-contract'
import {
  searchL4ProjectFiles,
  L4ProjectSearchError
} from '../src/server/l4_foundation/file/l4-project-search'
import { listL4WorkSessionProjectFiles } from '../src/server/l4_foundation/file/l4-work-session-project-file'
import { runRipgrep, type RipgrepMatch } from '../src/server/l4_foundation/file/l4-ripgrep-search'

const defaults: L4ProjectSearchInput = {
  query: 'needle',
  scope: 'all',
  caseSensitive: false,
  wholeWord: false,
  regex: false
}

async function fixture(
  context: test.TestContext,
  files: Record<string, string | Buffer> = {}
): Promise<string> {
  const parent = join(process.cwd(), 'temp/tests/project-search')
  await mkdir(parent, { recursive: true })
  const root = await mkdtemp(join(parent, 'search-boundaries-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  execFileSync('git', ['init', '--quiet', root], { windowsHide: true })
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true })
    await writeFile(join(root, path), content)
  }
  return root
}

async function search(
  cwd: string,
  input: Partial<L4ProjectSearchInput> = {}
): ReturnType<typeof searchL4ProjectFiles> {
  const result = await searchL4ProjectFiles(cwd, { ...defaults, ...input })
  assert.equal(L4ProjectFileSearchSchema.safeParse(result).success, true)
  return result
}

test('搜索条件保留首尾空格并拒绝空白、多行和无效选项', () => {
  assert.deepEqual(L4ProjectSearchInputSchema.parse({ query: ' word ' }), {
    ...defaults,
    query: ' word '
  })
  for (const query of ['', '  ', '\t', 'a\nb', 'a\rb', 'a\0b', 'a'.repeat(201)]) {
    assert.equal(L4ProjectSearchInputSchema.safeParse({ query }).success, false)
  }
  assert.equal(L4ProjectSearchInputSchema.safeParse({ query: 'x', scope: 'other' }).success, false)
  assert.equal(L4ProjectSearchInputSchema.safeParse({ query: 'x', regex: 'true' }).success, false)
})

test('三个范围独立执行，正文合并同一行的多处命中且每次读取磁盘', async (context) => {
  const root = await fixture(context, {
    'needle-name.txt': 'no match\n',
    'body.txt': 'needle needle\nnext\nneedle\n'
  })
  const files = await search(root, { scope: 'files' })
  assert.deepEqual(files.fileMatches, [{ path: 'needle-name.txt', ranges: [{ start: 0, end: 6 }] }])
  assert.deepEqual(files.contentMatches, [])
  const content = await search(root, { scope: 'content' })
  assert.deepEqual(content.fileMatches, [])
  assert.deepEqual(content.contentMatches, [
    {
      path: 'body.txt',
      line: 1,
      text: 'needle needle',
      ranges: [
        { start: 0, end: 6 },
        { start: 7, end: 13 }
      ]
    },
    { path: 'body.txt', line: 3, text: 'needle', ranges: [{ start: 0, end: 6 }] }
  ])
  assert.deepEqual(await search(root), { ...content, fileMatches: files.fileMatches })
  await writeFile(join(root, 'body.txt'), 'changed\n')
  assert.deepEqual((await search(root, { scope: 'content' })).contentMatches, [])
})

test('默认文件名保持精确、前缀、包含、路径包含和顺序模糊的优先级', async (context) => {
  const root = await fixture(context, {
    key: '',
    'key-long': '',
    'a-key': '',
    'key-dir/z.txt': '',
    'k-e-y.txt': '',
    ΟΣ: ''
  })
  const result = await search(root, { query: 'key', scope: 'files' })
  assert.deepEqual(
    result.fileMatches.map((match) => match.path),
    ['key', 'key-long', 'a-key', 'key-dir/z.txt', 'k-e-y.txt']
  )
  assert.deepEqual(result.fileMatches.at(-1)?.ranges, [
    { start: 0, end: 1 },
    { start: 2, end: 3 },
    { start: 4, end: 5 }
  ])
  assert.deepEqual((await search(root, { query: 'ΟΣ', scope: 'files' })).fileMatches, [
    { path: 'ΟΣ', ranges: [{ start: 0, end: 2 }] }
  ])
})

test('文件名与正文的大小写、全词和Rust正则语义一致', async (context) => {
  const root = await fixture(context, {
    'Session.txt': 'Session session sessions session_id SESSION\n',
    'sessions.txt': 'sessions\n',
    'session_id.txt': 'session_id\n',
    's-e-s-s-i-o-n.txt': 'none\n'
  })
  const insensitive = await search(root, { query: 'session' })
  assert.equal(insensitive.fileMatches.length, 4)
  const sensitive = await search(root, { query: 'session', caseSensitive: true })
  assert.equal(
    sensitive.fileMatches.some((match) => match.path === 'Session.txt'),
    false
  )
  assert.deepEqual(sensitive.contentMatches.find((match) => match.path === 'Session.txt')?.ranges, [
    { start: 8, end: 15 },
    { start: 16, end: 23 },
    { start: 25, end: 32 }
  ])
  const whole = await search(root, { query: 'session', wholeWord: true })
  assert.deepEqual(
    whole.fileMatches.map((match) => match.path),
    ['Session.txt']
  )
  assert.deepEqual(whole.contentMatches[0]?.ranges, [
    { start: 0, end: 7 },
    { start: 8, end: 15 },
    { start: 36, end: 43 }
  ])
  const regex = await search(root, { query: 's[eE]ssion(?:s)?', regex: true })
  assert.equal(
    regex.fileMatches.some((match) => match.path === 's-e-s-s-i-o-n.txt'),
    false
  )
  assert.equal(regex.fileMatches.length, 3)
})

test('UTF8字节偏移正确转换为UTF16，CRLF、中文、emoji、首尾空格与零宽命中可定位', async (context) => {
  const root = await fixture(context, {
    '中文😀.txt': 'header\r\n前😀needle 后 needle\r\n word \nword\n'
  })
  const result = await search(root, { scope: 'content' })
  assert.deepEqual(result.contentMatches, [
    {
      path: '中文😀.txt',
      line: 2,
      text: '前😀needle 后 needle',
      ranges: [
        { start: 3, end: 9 },
        { start: 12, end: 18 }
      ]
    }
  ])
  assert.equal((await search(root, { query: ' word ', scope: 'content' })).contentMatches.length, 1)
  assert.deepEqual((await search(root, { query: '😀', scope: 'files' })).fileMatches[0]?.ranges, [
    { start: 2, end: 4 }
  ])
  const zero = await search(root, { query: '^', scope: 'content', regex: true })
  assert.equal(zero.contentMatches.length, 4)
  assert.deepEqual(zero.contentMatches[0]?.ranges, [{ start: 0, end: 0 }])
})

test('非法表达式和不支持的环视在空项目和三个范围均拒绝', async (context) => {
  const root = await fixture(context)
  for (const query of ['[', '(?=needle)', 'a{1000000000}']) {
    for (const scope of ['files', 'content', 'all'] as const) {
      await assert.rejects(
        search(root, { query, scope, regex: true }),
        (error: unknown) =>
          error instanceof L4ProjectSearchError && error.kind === 'invalid-pattern'
      )
    }
  }
  await writeFile(join(root, '[.txt'), '[ literal\n')
  await listL4WorkSessionProjectFiles(root, '')
  assert.equal((await search(root, { query: '[' })).contentMatches.length, 1)
})

test('内容候选遵循多仓库、tracked忽略例外、隐藏文件、temp及子目录cwd', async (context) => {
  const root = await fixture(context, {
    '.gitignore': 'inner/\nignored.txt\n',
    'tracked.txt': 'needle',
    'ignored.txt': 'needle',
    'temp/keep.txt': 'needle',
    '.pi/config.txt': 'needle',
    'node_modules/no.txt': 'needle',
    'inner/child.txt': 'needle',
    'peer/other.txt': 'needle'
  })
  const git = (cwd: string, ...args: string[]): void => {
    execFileSync('git', ['-C', cwd, ...args], { windowsHide: true })
  }
  git(root, 'init', '--quiet')
  git(root, 'add', 'tracked.txt')
  await writeFile(join(root, '.gitignore'), 'inner/\nignored.txt\ntracked.txt\n')
  git(join(root, 'inner'), 'init', '--quiet')
  git(join(root, 'peer'), 'init', '--quiet')
  const result = await search(root, { scope: 'content' })
  assert.deepEqual(result.contentMatches.map((match) => match.path).sort(), [
    '.pi/config.txt',
    'inner/child.txt',
    'peer/other.txt',
    'temp/keep.txt',
    'tracked.txt'
  ])
  assert.deepEqual(
    (await search(join(root, 'temp'), { scope: 'content' })).contentMatches.map(
      (match) => match.path
    ),
    ['keep.txt']
  )
})

test('内容只搜索根内普通UTF8文本，跳过二进制、非UTF8、超大和符号链接', async (context) => {
  const root = await fixture(context, {
    'valid.txt': 'needle',
    'binary.dat': Buffer.from('needle\0binary'),
    'invalid.txt': Buffer.from([110, 101, 101, 100, 108, 101, 255]),
    'large.txt': Buffer.concat([Buffer.alloc(5 * 1024 * 1024 - 5, 0x61), Buffer.from('needle')]),
    'boundary.txt': `${'a\n'.repeat((5 * 1024 * 1024 - 6) / 2)}needle`
  })
  const external = await fixture(context, { 'outside.txt': 'needle' })
  try {
    await symlink(join(external, 'outside.txt'), join(root, 'linked.txt'), 'file')
    await symlink(
      external,
      join(root, 'linked-dir'),
      process.platform === 'win32' ? 'junction' : 'dir'
    )
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EPERM')) throw error
    context.diagnostic('当前平台没有创建文件符号链接的权限，文件链接分支未测')
  }
  const result = await search(root, { scope: 'content' })
  assert.deepEqual(
    result.contentMatches.map((match) => match.path),
    ['boundary.txt', 'valid.txt']
  )
  assert.equal(result.truncated, false)
  assert.equal((await search(root, { query: 'binary', scope: 'files' })).fileMatches.length, 1)
  assert.equal((await search(root, { query: 'large', scope: 'files' })).fileMatches.length, 1)
})

test('正文校验有界并发、完整检查UTF8且只在当前请求复用目录检查', async (context) => {
  const files = Object.fromEntries(
    Array.from({ length: 40 }, (_, index) => [`shared/nested/${index}.txt`, 'needle'])
  )
  files['shared/nested/late-invalid.txt'] = 'needle'
  const root = await fixture(context, files)
  await writeFile(
    join(root, 'shared/nested/late-invalid.txt'),
    Buffer.concat([Buffer.from('needle'), Buffer.alloc(70 * 1024, 0x61), Buffer.from([255])])
  )
  const originalOpen = fsPromises.open
  const originalLstat = fsPromises.lstat
  let active = 0
  let maximum = 0
  let directoryChecks = 0
  context.mock.method(fsPromises, 'open', async (...args: Parameters<typeof fsPromises.open>) => {
    const handle = await originalOpen(...args)
    active += 1
    maximum = Math.max(maximum, active)
    const close = handle.close.bind(handle)
    handle.close = async (): Promise<void> => {
      try {
        await close()
      } finally {
        active -= 1
      }
    }
    return handle
  })
  context.mock.method(fsPromises, 'lstat', ((...args: Parameters<typeof fsPromises.lstat>) => {
    if (args[0] === join(root, 'shared/nested')) directoryChecks += 1
    return Reflect.apply(originalLstat, fsPromises, args)
  }) as typeof fsPromises.lstat)
  syncBuiltinESMExports()
  context.after(() => {
    context.mock.restoreAll()
    syncBuiltinESMExports()
  })
  const result = await search(root, { scope: 'content' })
  assert.equal(result.contentMatches.length, 40)
  assert.equal(result.truncated, false)
  assert.ok(maximum > 1 && maximum <= 16)
  assert.equal(active, 0)
  assert.equal(directoryChecks, 1)
  // 修改正文不刷新候选索引；下一请求必须重新验证目录和完整文本。
  await writeFile(join(root, 'shared/nested/late-invalid.txt'), 'needle')
  assert.equal((await search(root, { scope: 'content' })).contentMatches.length, 41)
  assert.equal(directoryChecks, 2)
  const external = await fixture(context, { 'nested/0.txt': 'needle' })
  await rm(join(root, 'shared'), { recursive: true })
  try {
    await symlink(external, join(root, 'shared'), process.platform === 'win32' ? 'junction' : 'dir')
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EPERM')) throw error
    context.diagnostic('当前平台无创建目录链接权限，目录替换分支未测')
    return
  }
  assert.deepEqual((await search(root, { scope: 'content' })).contentMatches, [])
  assert.equal(active, 0)
})

test('正文并发验证被取消后等待全部句柄关闭且不启动rg', async (context) => {
  const root = await fixture(
    context,
    Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`shared/${index}.txt`, 'needle']))
  )
  await search(root, { scope: 'files' })
  const controller = new AbortController()
  const originalOpen = fsPromises.open
  let active = 0
  let opened = 0
  context.mock.method(fsPromises, 'open', async (...args: Parameters<typeof fsPromises.open>) => {
    const handle = await originalOpen(...args)
    active += 1
    opened += 1
    const close = handle.close.bind(handle)
    handle.close = async (): Promise<void> => {
      try {
        await close()
      } finally {
        active -= 1
      }
    }
    controller.abort()
    return handle
  })
  const spawn = context.mock.method(childProcess, 'spawn')
  syncBuiltinESMExports()
  context.after(() => {
    context.mock.restoreAll()
    syncBuiltinESMExports()
  })
  await assert.rejects(
    searchL4ProjectFiles(root, { ...defaults, scope: 'content' }, controller.signal),
    (error: unknown) => error instanceof Error && error.name === 'AbortError'
  )
  assert.ok(opened > 0 && opened <= 16)
  assert.equal(active, 0)
  assert.equal(spawn.mock.callCount(), 0)
  context.mock.restoreAll()
  syncBuiltinESMExports()
  assert.equal((await search(root, { scope: 'content' })).contentMatches.length, 40)
})

test('恰好达到结果上限不误报，额外命中才截断且片段不切断代理对', async (context) => {
  const root = await fixture(context, {
    'rows.txt': 'needle\n'.repeat(200),
    'long.txt': `${'😀'.repeat(601)}needle${'😀'.repeat(700)}\n`
  })
  const first = await search(root, { scope: 'content', query: '^needle$', regex: true })
  assert.equal(first.contentMatches.length, 200)
  assert.equal(first.truncated, false)
  await writeFile(join(root, 'rows.txt'), 'needle\n'.repeat(201))
  const more = await search(root, { scope: 'content', query: '^needle$', regex: true })
  assert.equal(more.contentMatches.length, 200)
  assert.equal(more.truncated, true)
  const long = await search(root, { scope: 'content', query: 'needle' })
  const match = long.contentMatches.find((entry) => entry.path === 'long.txt')!
  assert.ok(match.text.length <= 1000)
  assert.equal(match.text.slice(match.ranges[0]!.start, match.ranges[0]!.end), 'needle')
  assert.equal(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(match.text), false)
  const names = await fixture(
    context,
    Object.fromEntries(Array.from({ length: 100 }, (_, index) => [`needle-${index}.txt`, '']))
  )
  assert.equal((await search(names, { scope: 'files' })).truncated, false)
  await writeFile(join(names, 'needle-extra.txt'), '')
  await listL4WorkSessionProjectFiles(names, '')
  const files = await search(names, { scope: 'files' })
  assert.equal(files.fileMatches.length, 100)
  assert.equal(files.truncated, true)
})

test('真实rg的超长JSON行保留已有结果并截断，进程退出后可继续搜索', async (context) => {
  const root = await fixture(context, {
    'large-line.txt': `needle\n${'x'.repeat(1024 * 1024)}needle\n`
  })
  const result = await search(root, { scope: 'content' })
  assert.equal(result.truncated, true)
  assert.equal(result.contentMatches.length, 1)
  assert.equal(result.contentMatches[0]?.line, 1)
  assert.equal((await search(root, { query: 'absent', scope: 'content' })).truncated, false)
})

test('显式候选按参数长度分批，支持中文、空格和短横线文件名', async (context) => {
  const files = Object.fromEntries(
    Array.from({ length: 120 }, (_, index) => [
      `中文 空格-${index}-${'x'.repeat(90)}.txt`,
      'needle'
    ])
  )
  files['-leading.txt'] = 'needle'
  if (process.platform !== 'win32') files['line\nbreak.txt'] = 'needle'
  const root = await fixture(context, files)
  const original = childProcess.spawn
  let processCount = 0
  captureSpawn(context, ((...args: Parameters<typeof childProcess.spawn>) => {
    if ((args[1] as string[]).includes('--max-filesize')) processCount += 1
    return Reflect.apply(original, childProcess, args)
  }) as typeof childProcess.spawn)
  const result = await search(root, { scope: 'content' })
  assert.deepEqual(
    result.contentMatches.map((match) => match.path).sort(),
    Object.keys(files).sort()
  )
  assert.ok(processCount > 1 && processCount < Object.keys(files).length)
  const require = createRequire(import.meta.url)
  const { rgPath } = require('@vscode/ripgrep') as { rgPath: string }
  const direct = execFileSync(
    rgPath,
    [
      '--no-config',
      '--files-with-matches',
      '--null',
      '--fixed-strings',
      '-e',
      'needle',
      '--',
      ...Object.keys(files).map((path) => `./${path}`)
    ],
    { cwd: root, encoding: 'utf8', windowsHide: true }
  )
  assert.deepEqual(
    direct
      .split('\0')
      .filter(Boolean)
      .map((path) => path.replace(/^\.\//, '').replaceAll('\\', '/'))
      .sort(),
    Object.keys(files).sort()
  )
  const small = await fixture(context, Object.fromEntries(Object.entries(files).slice(0, 12)))
  for (const [cwd, count] of [
    [small, 12],
    [root, Object.keys(files).length]
  ] as const) {
    const cold: number[] = []
    const hot: number[] = []
    const processes: number[] = []
    for (let index = 0; index < 3; index += 1) {
      await listL4WorkSessionProjectFiles(cwd, '')
      processCount = 0
      let started = performance.now()
      assert.equal((await search(cwd, { scope: 'content' })).contentMatches.length, count)
      cold.push(Math.round(performance.now() - started))
      processes.push(processCount)
      processCount = 0
      started = performance.now()
      assert.equal((await search(cwd, { scope: 'content' })).contentMatches.length, count)
      hot.push(Math.round(performance.now() - started))
      processes.push(processCount)
    }
    context.diagnostic(
      JSON.stringify({
        platform: process.platform,
        arch: process.arch,
        files: count,
        bytes: count * 6,
        indexColdMs: cold,
        indexHotMs: hot,
        rgProcessCounts: processes
      })
    )
  }
  const paths = await search(root, { query: '中文|leading|break', scope: 'files', regex: true })
  assert.equal(paths.fileMatches.length, 100)
  assert.equal(paths.truncated, true)
})

function captureSpawn(context: test.TestContext, replacement: typeof childProcess.spawn): void {
  context.mock.method(childProcess, 'spawn', replacement)
  syncBuiltinESMExports()
  context.after(() => {
    context.mock.restoreAll()
    syncBuiltinESMExports()
  })
}

test('普通文件名搜索不启动rg，文件高级选项仅通过stdin匹配路径', async (context) => {
  const root = await fixture(context, { 'needle.txt': 'body-only', 'other.txt': 'needle' })
  const original = childProcess.spawn
  const invocations: string[][] = []
  captureSpawn(context, ((...args: Parameters<typeof childProcess.spawn>) => {
    invocations.push(args[1] as string[])
    return Reflect.apply(original, childProcess, args)
  }) as typeof childProcess.spawn)
  // 先构建缓存，索引自己的 Git 探测不属于 rg 搜索进程。
  await search(root, { query: 'body-only', scope: 'files' })
  invocations.length = 0
  await search(root, { query: 'body-only', scope: 'files' })
  assert.equal(invocations.length, 0)
  assert.deepEqual(
    (await search(root, { query: 'body-only', scope: 'files', regex: true })).fileMatches,
    []
  )
  assert.equal(invocations.length, 1)
  assert.ok(invocations[0]?.includes('--null-data'))
  assert.equal(invocations[0]?.at(-1), '-')
})

function rgEvent(text: string): Buffer {
  return Buffer.from(
    `${JSON.stringify({ type: 'match', data: { path: { text: './sample.txt' }, lines: { text }, line_number: 1, submatches: [{ start: 0, end: Buffer.byteLength(text) }] } })}\n`
  )
}

function fakeSpawn(
  context: test.TestContext,
  output: Buffer[],
  code = 0,
  stderr = '',
  autoClose = true
): { getKilled: () => boolean; spawned: Promise<EventEmitter> } {
  let killed = false
  let resolveSpawn: (child: EventEmitter) => void
  const spawned = new Promise<EventEmitter>((resolve) => {
    resolveSpawn = resolve
  })
  captureSpawn(context, (() => {
    const child = Object.assign(new childProcess.ChildProcess(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: (): boolean => {
        killed = true
        queueMicrotask(() => child.emit('close', null))
        return true
      }
    })
    resolveSpawn(child)
    queueMicrotask(() => {
      for (const chunk of output) child.stdout.emit('data', chunk)
      if (stderr) child.stderr.emit('data', Buffer.from(stderr))
      if (autoClose && !killed) child.emit('close', code)
    })
    return child
  }) as typeof childProcess.spawn)
  return { getKilled: () => killed, spawned }
}

test('JSON跨UTF8与记录边界分块解析，退出1是成功空结果', async (context) => {
  const bytes = rgEvent('中文😀')
  fakeSpawn(
    context,
    Array.from(bytes, (byte) => Buffer.from([byte]))
  )
  const matches: RipgrepMatch[] = []
  assert.equal(
    await runRipgrep(
      process.cwd(),
      [],
      { deadline: Date.now() + 1000, outputBytes: 0 },
      undefined,
      (match) => {
        matches.push(match)
        return true
      }
    ),
    false
  )
  assert.equal(matches[0]?.lines.text, '中文😀')
  context.mock.restoreAll()
  syncBuiltinESMExports()
  fakeSpawn(context, [], 1)
  assert.equal(
    await runRipgrep(
      process.cwd(),
      [],
      { deadline: Date.now() + 1000, outputBytes: 0 },
      undefined,
      () => true
    ),
    false
  )
})

test('单条JSON、累计输出、stderr都受限，超限杀进程并返回截断', async (context) => {
  for (const chunks of [
    [Buffer.alloc(1024 * 1024 + 1, 0x61)],
    Array.from({ length: 6 }, () =>
      Buffer.concat(Array.from({ length: 10000 }, () => rgEvent('x')))
    )
  ]) {
    const fake = fakeSpawn(context, chunks)
    const signal = new AbortController().signal
    assert.equal(
      await runRipgrep(
        process.cwd(),
        [],
        { deadline: Date.now() + 1000, outputBytes: 0 },
        signal,
        () => true
      ),
      true
    )
    assert.equal(fake.getKilled(), true)
    assert.equal(getEventListeners(signal, 'abort').length, 0)
    context.mock.restoreAll()
    syncBuiltinESMExports()
  }
  fakeSpawn(context, [], 2, 'x'.repeat(100000))
  await assert.rejects(
    runRipgrep(
      process.cwd(),
      [],
      { deadline: Date.now() + 1000, outputBytes: 0 },
      undefined,
      () => true
    ),
    (error: unknown) =>
      error instanceof L4ProjectSearchError &&
      error.kind === 'read-failed' &&
      error.message.length < 66000
  )
})

test('rg退出2、启动失败及执行超时保留错误类别并释放监听器', async (context) => {
  fakeSpawn(context, [], 2, 'regex parse error: invalid')
  await assert.rejects(
    runRipgrep(
      process.cwd(),
      [],
      { deadline: Date.now() + 1000, outputBytes: 0 },
      undefined,
      () => true
    ),
    (error: unknown) => error instanceof L4ProjectSearchError && error.kind === 'invalid-pattern'
  )
  context.mock.restoreAll()
  syncBuiltinESMExports()
  const failure = fakeSpawn(context, [], 2, '', false)
  const promise = runRipgrep(
    process.cwd(),
    [],
    { deadline: Date.now() + 1000, outputBytes: 0 },
    undefined,
    () => true
  )
  const failedChild = await failure.spawned
  failedChild.emit('error', new Error('spawn failed'))
  failedChild.emit('close', null)
  await assert.rejects(
    promise,
    (error: unknown) => error instanceof L4ProjectSearchError && error.kind === 'unavailable'
  )
  context.mock.restoreAll()
  syncBuiltinESMExports()
  const timeout = fakeSpawn(context, [], 0, '', false)
  const signal = new AbortController().signal
  await assert.rejects(
    runRipgrep(
      process.cwd(),
      [],
      { deadline: Date.now() + 15, outputBytes: 0 },
      signal,
      () => true
    ),
    (error: unknown) => error instanceof L4ProjectSearchError && error.kind === 'timeout'
  )
  assert.equal(timeout.getKilled(), true)
  assert.equal(getEventListeners(signal, 'abort').length, 0)
})

test('真实rg取消只终止当前搜索进程，另一搜索与共享索引仍可用', async (context) => {
  const root = await fixture(context, { 'needle.txt': 'needle\n'.repeat(1000) })
  await search(root, { scope: 'files' })
  const controller = new AbortController()
  const original = childProcess.spawn
  let cancelledChild: ReturnType<typeof childProcess.spawn> | undefined
  captureSpawn(context, ((...args: Parameters<typeof childProcess.spawn>) => {
    const child = Reflect.apply(original, childProcess, args) as ReturnType<
      typeof childProcess.spawn
    >
    if (!cancelledChild && (args[1] as string[]).includes('--max-filesize')) {
      cancelledChild = child
      child.once('spawn', () => controller.abort())
    }
    return child
  }) as typeof childProcess.spawn)
  const cancelled = searchL4ProjectFiles(root, { ...defaults, scope: 'content' }, controller.signal)
  const independent = search(root, { scope: 'files', regex: true })
  await assert.rejects(
    cancelled,
    (error: unknown) => error instanceof Error && error.name === 'AbortError'
  )
  assert.equal((await independent).fileMatches.length, 1)
  assert.ok(cancelledChild)
  assert.equal(cancelledChild.killed, true)
  assert.notEqual(cancelledChild.exitCode, 0)
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
  assert.deepEqual(
    (await search(root, { scope: 'files' })).fileMatches.map((match) => match.path),
    ['needle.txt']
  )
})

test('运行依赖缺失不返回空结果', () => {
  const entry = new URL('../src/server/l4_foundation/file/l4-ripgrep-search.ts', import.meta.url)
    .href
  const script = `
    import assert from 'node:assert/strict'
    import { registerHooks } from 'node:module'
    let blocked = 0
    const hooks = registerHooks({
      resolve(specifier, context, nextResolve) {
        if (specifier === '@vscode/ripgrep') {
          blocked += 1
          throw new Error('测试环境缺少 @vscode/ripgrep')
        }
        return nextResolve(specifier, context)
      }
    })
    try {
      const loaded = await import(${JSON.stringify(entry)})
      const { runRipgrep, L4ProjectSearchError } = loaded.default ?? loaded
      await assert.rejects(
        runRipgrep(process.cwd(), [], { deadline: Date.now() + 1000, outputBytes: 0 }, undefined, () => true),
        (error) => error instanceof L4ProjectSearchError && error.kind === 'unavailable'
      )
      assert.ok(blocked > 0)
      console.log('missing-ripgrep-unavailable')
    } finally {
      hooks.deregister()
    }
  `
  const output = execFileSync(
    process.execPath,
    ['--conditions=react-server', '--import', 'tsx', '--input-type=module', '--eval', script],
    {
      cwd: process.cwd(),
      env: { ...process.env, TSX_TSCONFIG_PATH: join(process.cwd(), 'tsconfig.json') },
      windowsHide: true,
      timeout: 10_000,
      encoding: 'utf8'
    }
  )
  assert.match(output, /missing-ripgrep-unavailable/)
})
