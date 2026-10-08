import { execFile } from 'node:child_process'
import { realpath } from 'node:fs/promises'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const pageBytes = 12 * 1024

export class ReleaseAgentError extends Error {
  constructor(category) {
    super(`发布说明错误：${category}`)
    this.category = category
  }
}

function fail(category) {
  throw new ReleaseAgentError(category)
}

function allowedPath(path) {
  if (
    typeof path !== 'string' ||
    !path ||
    path.length > 1024 ||
    /[\\:\u0000-\u001f\u007f]/u.test(path) ||
    path.split('/').some((part) => !part || part === '.' || part === '..')
  )
    return false
  const lower = path.toLowerCase()
  const parts = lower.split('/')
  const name = parts.at(-1)
  return !(
    parts.some((part) =>
      ['temp', 'secrets', 'private', '.pi', '.git', 'node_modules'].includes(part)
    ) ||
    /^(?:config\/|docs\/(?:notes|codebase)\/)/u.test(lower) ||
    /^plugins\/pi-desk-(?:git-workflows|image-generation|jk|task-ssh|workspace)\//u.test(lower) ||
    /^(?:\.env(?:\.|$)|\.npmrc$|\.netrc$|auth\.json$|models\.json$|agents(?:\.override)?\.md$|claude\.md$|system\.md$)/u.test(
      name
    ) ||
    /(?:\.lockb?|\.pem|\.key|\.p12|\.pfx|\.keystore|\.jks)$/u.test(name) ||
    /\.(?:png|jpe?g|gif|webp|bmp|ico|pdf|woff2?|ttf|otf|mp[34]|wav|ogg|zip|gz|7z|exe|dll|dmg|apk|aab|wasm)$/u.test(
      name
    ) ||
    /^(?:package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.ya?ml|packages\.lock\.json|go\.sum)$/u.test(
      name
    )
  )
}

function offsetValue(offset, total) {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > total) fail('INVALID_OFFSET')
  return offset
}

function page(text, offset = 0) {
  const bytes = Buffer.from(text)
  offsetValue(offset, bytes.length)
  if (offset < bytes.length && (bytes[offset] & 0xc0) === 0x80) fail('INVALID_OFFSET')
  let end = Math.min(offset + pageBytes, bytes.length)
  while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end -= 1
  return {
    offset,
    end,
    totalBytes: bytes.length,
    nextOffset: end < bytes.length ? end : null,
    text: bytes.subarray(offset, end).toString('utf8')
  }
}

function textData(bytes) {
  if (bytes.includes(0)) fail('BINARY')
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    fail('BINARY')
  }
}

export async function createGitEvidence({ root, source, signal }) {
  if (
    !source ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(source.head) ||
    (source.base !== null && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(source.base))
  )
    fail('INVALID_SOURCE')
  source = { base: source.base, head: source.head }
  root = await realpath(root)
  const environment = Object.fromEntries(
    ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP']
      .filter((key) => process.env[key] !== undefined)
      .map((key) => [key, process.env[key]])
  )
  Object.assign(environment, {
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_ATTR_NOSYSTEM: '1',
    GIT_ATTR_SOURCE: source.head
  })
  async function git(args, toolSignal) {
    try {
      const pending = execFileAsync(
        'git',
        ['--no-pager', '--literal-pathspecs', '-c', 'core.attributesFile=', ...args],
        {
          cwd: root,
          env: environment,
          encoding: 'buffer',
          maxBuffer: 32 * 1024 * 1024,
          timeout: 30_000,
          signal:
            toolSignal && signal ? AbortSignal.any([signal, toolSignal]) : (toolSignal ?? signal)
        }
      )
      pending.child.stdin.end()
      const { stdout } = await pending
      return stdout
    } catch (error) {
      fail(error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? 'EVIDENCE_SIZE' : 'GIT')
    }
  }
  const repository = (await git(['rev-parse', '--show-toplevel'])).toString('utf8').trim()
  if ((await realpath(repository)) !== root) fail('REPOSITORY')
  for (const sha of [source.base, source.head].filter(Boolean)) {
    const actual = (await git(['rev-parse', '--verify', '--end-of-options', `${sha}^{commit}`]))
      .toString('utf8')
      .trim()
    if (actual !== sha) fail('INVALID_SOURCE')
  }
  const emptyTree = (await git(['hash-object', '-t', 'tree', '--stdin'])).toString('utf8').trim()
  const before = source.base ?? emptyTree
  const trees = {}
  for (const revision of ['base', 'head']) {
    const sha = source[revision]
    const tree = sha ? (await git(['ls-tree', '-r', '-z', sha])).toString('utf8') : ''
    trees[revision] = new Map(
      tree
        .split('\0')
        .filter(Boolean)
        .map((entry) => {
          const match = entry.match(/^(\d+) (\w+) ([a-f0-9]+)\t([\s\S]+)$/u)
          if (!match) fail('GIT_DATA')
          return [match[4], { mode: match[1], type: match[2], oid: match[3] }]
        })
    )
  }
  function entryAt(revision, path) {
    if (!['base', 'head'].includes(revision) || !source[revision]) fail('REVISION')
    if (!allowedPath(path)) fail('PATH')
    const entry = trees[revision].get(path)
    if (!entry || entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode)) fail('PATH')
    return entry
  }
  const diffArgs = ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', before, source.head]
  const stats = (await git([...diffArgs, '--numstat', '-z', '--'])).toString('utf8')
  const changes = stats
    .split('\0')
    .filter(Boolean)
    .flatMap((row) => {
      const match = row.match(/^(\d+|-)\t(\d+|-)\t([\s\S]+)$/u)
      if (!match) fail('GIT_DATA')
      const path = match[3]
      const entries = [trees.base.get(path), trees.head.get(path)].filter(Boolean)
      if (
        match[1] === '-' ||
        match[2] === '-' ||
        !allowedPath(path) ||
        entries.some((entry) => entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode))
      )
        return []
      return [
        {
          path,
          status: !trees.base.has(path) ? 'added' : !trees.head.has(path) ? 'removed' : 'changed'
        }
      ]
    })
  const changedPaths = new Set(changes.map(({ path }) => path))
  const requiredPaths =
    source.base === null
      ? changes
          .filter(({ path }) =>
            /^(?:package\.json|README(?:\.[a-zA-Z-]+)?\.md|bin\/[^/]+|plugins\/[^/]+\/(?:package\.json|src\/(?:index|entry)\.[cm]?[jt]s)|apps\/[^/]+\/(?:package\.json|README\.md)|apps\/website\/content\/docs\/[^/]+\.md)$/.test(
              path
            )
          )
          .map(({ path }) => path)
      : [...changedPaths]
  let cachedKey
  let cachedText
  async function fileText(revision, path, toolSignal) {
    const entry = entryAt(revision, path)
    return textData(await git(['cat-file', 'blob', entry.oid], toolSignal))
  }
  return {
    source: { ...source },
    changedPaths: [...changedPaths],
    requiredPaths: requiredPaths.length ? requiredPaths : [...changedPaths],
    async listChanges({ offset = 0 } = {}) {
      offsetValue(offset, changes.length)
      let end = offset
      let bytes = 2
      const files = []
      while (end < changes.length && files.length < 200) {
        const item = changes[end]
        const file = {
          ...item,
          required:
            source.base !== null || requiredPaths.includes(item.path) || !requiredPaths.length
        }
        const size = Buffer.byteLength(JSON.stringify(file)) + 1
        if (bytes + size > pageBytes && files.length) break
        files.push(file)
        bytes += size
        end += 1
      }
      return {
        offset,
        end,
        total: changes.length,
        nextOffset: end < changes.length ? end : null,
        files
      }
    },
    async readFile({ revision, path, offset = 0 }, toolSignal) {
      const key = `file:${revision}:${path}`
      if (cachedKey !== key) {
        cachedText = await fileText(revision, path, toolSignal)
        cachedKey = key
      }
      return { revision, path, ...page(cachedText, offset) }
    },
    async readDiff({ path, offset = 0 }, toolSignal) {
      if (!allowedPath(path) || !changedPaths.has(path)) fail('PATH')
      const key = `diff:${path}`
      if (cachedKey !== key) {
        try {
          for (const revision of ['base', 'head']) {
            if (trees[revision].has(path)) await fileText(revision, path, toolSignal)
          }
        } catch (error) {
          if (error instanceof ReleaseAgentError && error.category === 'BINARY') {
            return { path, excluded: 'binary', ...page('', offset) }
          }
          throw error
        }
        cachedText = textData(
          await git([...diffArgs, '--text', '--unified=3', '--', path], toolSignal)
        )
        cachedKey = key
      }
      return { path, ...page(cachedText, offset) }
    },
    async search({ revision, path, query, offset = 0 }, toolSignal) {
      if (typeof query !== 'string' || !query || query.length > 200) fail('QUERY')
      const data = await this.readFile({ revision, path, offset }, toolSignal)
      const matches = []
      let position = data.text.indexOf(query)
      let count = 0
      while (position !== -1) {
        count += 1
        if (matches.length < 20)
          matches.push(data.text.slice(Math.max(0, position - 60), position + query.length + 60))
        position = data.text.indexOf(query, position + query.length)
      }
      const { text, ...metadata } = data
      return { ...metadata, matches, matchCount: count, omittedMatches: count - matches.length }
    },
    async log({ path, offset = 0 }, toolSignal) {
      if (!allowedPath(path) || !changedPaths.has(path)) fail('PATH')
      offsetValue(offset, 10_000)
      const range = source.base ? `${source.base}..${source.head}` : source.head
      const lines = textData(
        await git(
          ['log', range, '--format=%H %s', '--max-count=21', `--skip=${offset}`, '--', path],
          toolSignal
        )
      )
        .trim()
        .split('\n')
        .filter(Boolean)
      return {
        path,
        offset,
        entries: lines.slice(0, 20),
        nextOffset: lines.length > 20 ? offset + 20 : null
      }
    }
  }
}
