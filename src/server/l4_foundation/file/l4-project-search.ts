import 'server-only'

import { lstat, open, realpath, stat } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import {
  L4_PROJECT_CONTENT_SEARCH_MAX_RESULTS,
  L4_PROJECT_FILE_SEARCH_MAX_RESULTS,
  L4_PROJECT_SEARCH_TEXT_MAX_LENGTH,
  L4_PROJECT_TEXT_FILE_MAX_BYTES,
  L4ProjectFilePathSchema,
  L4ProjectSearchInputSchema,
  type L4ProjectContentMatch,
  type L4ProjectFileMatch,
  type L4ProjectFileSearch,
  type L4ProjectSearchInput,
  type L4ProjectSearchRange
} from '@common/l4_foundation/file/l4-project-file-contract'
import { isL4PathInsideRoot } from './l4-file-path'
import { getSearchIndex } from './l4-project-file-index'
import { L4WorkSessionProjectFileError } from './l4-work-session-project-file'
import {
  checkSearchActive,
  L4ProjectSearchError,
  ripgrepPatternArgs,
  ripgrepText,
  runRipgrep,
  type RipgrepBudget,
  type RipgrepMatch
} from './l4-ripgrep-search'

export { L4ProjectSearchError } from './l4-ripgrep-search'

// 预留 rg 可执行路径、选项及 Windows 的参数转义开销。
const MAX_BATCH_ARGUMENT_UNITS = 16_000
const TEXT_VALIDATION_CONCURRENCY = 16

function plainFileMatch(
  path: string,
  input: L4ProjectSearchInput
): { match: L4ProjectFileMatch; score: number } | null {
  // 词尾 Σ 等转换依赖上下文，匹配值必须整串折叠。
  const value = input.caseSensitive ? path : path.toLocaleLowerCase()
  const query = input.caseSensitive ? input.query : input.query.toLocaleLowerCase()
  const name = basename(value)
  const nameOffset = value.length - name.length
  let score: number
  let positions: number[]
  if (name === query) {
    score = 0
    positions = Array.from({ length: query.length }, (_, index) => nameOffset + index)
  } else if (name.startsWith(query)) {
    score = 100 + name.length - query.length
    positions = Array.from({ length: query.length }, (_, index) => nameOffset + index)
  } else if (name.includes(query)) {
    const start = name.indexOf(query)
    score = 1_000 + start * 4 + name.length
    positions = Array.from({ length: query.length }, (_, index) => nameOffset + start + index)
  } else if (value.includes(query)) {
    const start = value.indexOf(query)
    score = 10_000 + start * 4 + value.length
    positions = Array.from({ length: query.length }, (_, index) => start + index)
  } else {
    positions = []
    let next = 0
    for (let index = 0; index < value.length && next < query.length; index += 1) {
      if (value[index] === query[next]) {
        positions.push(index)
        next += 1
      }
    }
    if (next !== query.length) return null
    const gaps = positions.at(-1)! - positions[0]! + 1 - query.length
    score = 100_000 + positions[0]! * 4 + gaps + value.length
  }
  const offsets: Array<{ start: number; end: number }> = []
  let offset = 0
  for (const character of path) {
    const folded = input.caseSensitive ? character : character.toLocaleLowerCase()
    for (let index = 0; index < folded.length; index += 1) {
      offsets.push({ start: offset, end: offset + character.length })
    }
    offset += character.length
  }
  const ranges: L4ProjectSearchRange[] = []
  for (const position of positions) {
    const range = offsets[position]!
    const previous = ranges.at(-1)
    if (previous && previous.end >= range.start) previous.end = Math.max(previous.end, range.end)
    else ranges.push({ ...range })
  }
  return { match: { path, ranges }, score }
}

function utf16Ranges(text: string, match: RipgrepMatch): L4ProjectSearchRange[] {
  const bytes = Buffer.from(ripgrepText(match.lines))
  // rg 的命中有序且不重叠，逐段转换避免反复解码整段行前缀。
  let byteOffset = 0
  let utf16Offset = 0
  const convert = (offset: number): number => {
    utf16Offset += bytes.subarray(byteOffset, offset).toString('utf8').length
    byteOffset = offset
    return Math.min(text.length, utf16Offset)
  }
  return match.submatches.map(({ start, end }) => ({ start: convert(start), end: convert(end) }))
}

function contentMatch(path: string, match: RipgrepMatch): L4ProjectContentMatch {
  const text = ripgrepText(match.lines).replace(/\r?\n$/, '')
  const ranges = utf16Ranges(text, match)
  let start = Math.max(0, (ranges[0]?.start ?? 0) - 200)
  let end = Math.min(text.length, start + L4_PROJECT_SEARCH_TEXT_MAX_LENGTH)
  if (start > 0 && /[\uDC00-\uDFFF]/.test(text[start]!) && /[\uD800-\uDBFF]/.test(text[start - 1]!))
    start += 1
  if (
    end < text.length &&
    /[\uD800-\uDBFF]/.test(text[end - 1]!) &&
    /[\uDC00-\uDFFF]/.test(text[end]!)
  )
    end -= 1
  return {
    path,
    line: match.line_number,
    text: text.slice(start, end),
    ranges: ranges
      .filter((range) => range.end >= start && range.start <= end)
      .map((range) => ({
        start: Math.max(start, range.start) - start,
        end: Math.min(end, range.end) - start
      }))
  }
}

async function isSearchableDirectory(
  root: string,
  path: string,
  checks: Map<string, Promise<boolean>>
): Promise<boolean> {
  if (!path) return true
  const cached = checks.get(path)
  if (cached) return cached
  const check = (async (): Promise<boolean> => {
    const slash = path.lastIndexOf('/')
    if (!(await isSearchableDirectory(root, slash < 0 ? '' : path.slice(0, slash), checks)))
      return false
    const info = await lstat(resolve(root, path))
    return info.isDirectory() && !info.isSymbolicLink()
  })()
  checks.set(path, check)
  return check
}

async function isSearchableText(
  root: string,
  path: string,
  signal: AbortSignal | undefined,
  budget: RipgrepBudget,
  directoryChecks: Map<string, Promise<boolean>>
): Promise<boolean> {
  try {
    checkSearchActive(signal, budget)
    const slash = path.lastIndexOf('/')
    if (
      !(await isSearchableDirectory(root, slash < 0 ? '' : path.slice(0, slash), directoryChecks))
    )
      return false
    checkSearchActive(signal, budget)
    const target = resolve(root, path)
    const info = await lstat(target)
    if (!info.isFile() || info.isSymbolicLink() || info.size > L4_PROJECT_TEXT_FILE_MAX_BYTES)
      return false
    if (!isL4PathInsideRoot(root, await realpath(target))) return false
    checkSearchActive(signal, budget)
    const handle = await open(target, 'r')
    try {
      const decoder = new TextDecoder('utf-8', { fatal: true })
      const buffer = Buffer.alloc(64 * 1024)
      let total = 0
      for (;;) {
        checkSearchActive(signal, budget)
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, null)
        if (bytesRead === 0) break
        total += bytesRead
        if (total > L4_PROJECT_TEXT_FILE_MAX_BYTES) return false
        const bytes = buffer.subarray(0, bytesRead)
        if (bytes.includes(0)) return false
        try {
          decoder.decode(bytes, { stream: true })
        } catch {
          return false
        }
      }
      try {
        decoder.decode()
      } catch {
        return false
      }
      return true
    } finally {
      await handle.close()
    }
  } catch (error) {
    checkSearchActive(signal, budget)
    if (
      error instanceof Error &&
      'code' in error &&
      (error.code === 'ENOENT' || error.code === 'ENOTDIR')
    )
      return false
    throw new L4ProjectSearchError('read-failed', `无法读取搜索文件：${path}`)
  }
}

async function waitForIndex(
  root: string,
  signal: AbortSignal | undefined,
  budget: RipgrepBudget
): ReturnType<typeof getSearchIndex> {
  checkSearchActive(signal, budget)
  return new Promise((resolveIndex, rejectIndex) => {
    const cleanup = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
    }
    const abort = (): void => {
      cleanup()
      rejectIndex(signal?.reason ?? new DOMException('搜索已取消', 'AbortError'))
    }
    const timer = setTimeout(
      () => {
        cleanup()
        rejectIndex(new L4ProjectSearchError('timeout', '项目搜索超时，请缩小搜索范围'))
      },
      Math.max(1, budget.deadline - Date.now())
    )
    signal?.addEventListener('abort', abort, { once: true })
    // 只取消本次等待，不中止其他调用者共用的索引构建。
    getSearchIndex(root).then(resolveIndex, rejectIndex).finally(cleanup)
  })
}

export async function searchL4ProjectFiles(
  cwd: string,
  input: L4ProjectSearchInput,
  signal?: AbortSignal
): Promise<L4ProjectFileSearch> {
  const started = Date.now()
  const budget: RipgrepBudget = { deadline: started + 10_000, outputBytes: 0 }
  let stage = 'index'
  try {
    checkSearchActive(signal, budget)
    // HTTP 以外的调用者也遵守公共搜索条件，实际搜索词不 trim。
    if (!L4ProjectSearchInputSchema.safeParse(input).success)
      throw new L4ProjectSearchError('invalid-pattern', '搜索条件无效')
    let root: string
    try {
      root = await realpath(cwd)
      if (!(await stat(root)).isDirectory())
        throw new L4WorkSessionProjectFileError('not-directory', '项目根路径不是目录')
    } catch (error) {
      if (error instanceof L4WorkSessionProjectFileError) throw error
      throw new L4WorkSessionProjectFileError('not-found', '项目目录不存在')
    }
    const index = await waitForIndex(root, signal, budget)
    checkSearchActive(signal, budget)
    const paths = index.files.filter((path) => L4ProjectFilePathSchema.safeParse(path).success)
    const result: L4ProjectFileSearch = {
      fileMatches: [],
      contentMatches: [],
      truncated: index.truncated
    }
    const args = ripgrepPatternArgs(input)
    if (input.scope !== 'content') {
      stage = 'files'
      if (input.regex || input.wholeWord) {
        const candidates = new Set(paths)
        const truncated = await runRipgrep(
          root,
          [...args, '--null-data', '-'],
          budget,
          signal,
          (match) => {
            const path = ripgrepText(match.lines).replace(/\0$/, '')
            if (!candidates.has(path)) return true
            if (result.fileMatches.length >= L4_PROJECT_FILE_SEARCH_MAX_RESULTS) return false
            result.fileMatches.push({ path, ranges: utf16Ranges(path, match) })
            return true
          },
          (function* (): Generator<string> {
            for (const path of paths) yield `${path}\0`
          })()
        )
        result.truncated ||= truncated
      } else {
        const matches = paths
          .flatMap((path) => {
            const match = plainFileMatch(path, input)
            return match ? [match] : []
          })
          .sort(
            (left, right) =>
              left.score - right.score || left.match.path.localeCompare(right.match.path)
          )
        result.fileMatches = matches
          .slice(0, L4_PROJECT_FILE_SEARCH_MAX_RESULTS)
          .map(({ match }) => match)
        result.truncated ||= matches.length > L4_PROJECT_FILE_SEARCH_MAX_RESULTS
      }
    }
    // 输出预算已经耗尽时，不再启动正文批次；文件结果截断不影响正文分支。
    if (input.scope !== 'files' && budget.outputBytes <= 4 * 1024 * 1024) {
      stage = 'content'
      let batch: string[] = []
      let units = 0
      let searched = false
      let stopped = false
      // 只在本次请求复用目录检查；不保存正文或跨请求的校验结论。
      const directoryChecks = new Map<string, Promise<boolean>>()
      const flush = async (): Promise<void> => {
        const validPaths: string[] = []
        for (let offset = 0; offset < batch.length; offset += TEXT_VALIDATION_CONCURRENCY) {
          checkSearchActive(signal, budget)
          const paths = batch.slice(offset, offset + TEXT_VALIDATION_CONCURRENCY)
          // 等待同组全部释放文件句柄后再抛错，不让取消留下后台校验。
          const checked = await Promise.allSettled(
            paths.map((path) => isSearchableText(root, path, signal, budget, directoryChecks))
          )
          for (const [index, entry] of checked.entries()) {
            if (entry.status === 'rejected') throw entry.reason
            if (entry.value) validPaths.push(paths[index]!)
          }
        }
        batch = []
        units = 0
        if (validPaths.length === 0) return
        searched = true
        const candidates = new Set(validPaths)
        stopped = await runRipgrep(
          root,
          [
            ...args,
            '--no-ignore',
            '--hidden',
            '--no-follow',
            '--no-mmap',
            '--threads',
            '1',
            '--encoding',
            'utf-8',
            '--max-filesize',
            String(L4_PROJECT_TEXT_FILE_MAX_BYTES),
            '--',
            ...validPaths.map((path) => `./${path}`)
          ],
          budget,
          signal,
          (match) => {
            const path = ripgrepText(match.path).replace(/^\.\//, '').replaceAll('\\', '/')
            if (!candidates.has(path) || !L4ProjectFilePathSchema.safeParse(path).success)
              return true
            if (result.contentMatches.length >= L4_PROJECT_CONTENT_SEARCH_MAX_RESULTS) return false
            result.contentMatches.push(contentMatch(path, match))
            return true
          }
        )
        result.truncated ||= stopped
      }
      for (const path of paths) {
        checkSearchActive(signal, budget)
        const cost = Math.max(path.length, Buffer.byteLength(path)) * 2 + 8
        if (units + cost > MAX_BATCH_ARGUMENT_UNITS) await flush()
        if (stopped) break
        batch.push(path)
        units += cost
      }
      if (!stopped) await flush()
      // 空项目同样交给 Rust 引擎验证正则语法。
      if (!searched && input.regex && input.scope === 'content') {
        const truncated = await runRipgrep(root, [...args, '-'], budget, signal, () => true)
        result.truncated ||= truncated
      }
      result.contentMatches.sort(
        (left, right) => left.path.localeCompare(right.path) || left.line - right.line
      )
    }
    checkSearchActive(signal, budget)
    return result
  } catch (error) {
    if (!signal?.aborted && !(error instanceof Error && error.name === 'AbortError')) {
      console.warn('[Pi Desk][Project Search] 项目搜索失败', {
        cwd,
        scope: input.scope,
        stage,
        elapsedMs: Date.now() - started,
        reason: error instanceof Error ? error.message : String(error)
      })
    }
    throw error
  }
}
