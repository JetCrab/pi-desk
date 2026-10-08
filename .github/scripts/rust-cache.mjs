import assert from 'node:assert/strict'
import { cp, mkdir, readdir, rm } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

export async function transferRustCache(source, destination) {
  let entries
  try {
    entries = await readdir(source, { withFileTypes: true })
  } catch (error) {
    if (error.code === 'ENOENT') return 0
    throw error
  }
  await mkdir(destination, { recursive: true })
  let copied = 0
  for (const entry of entries) {
    if (
      !entry.isDirectory() ||
      !/^(debug|release|[^/]+-(?:windows|apple|linux)[^/]*)$/.test(entry.name)
    )
      continue
    await cp(join(source, entry.name), join(destination, entry.name), {
      recursive: true,
      preserveTimestamps: true,
      filter: (path) => {
        const name = basename(path)
        if (['bundle', 'nsis', '.tauri'].includes(name)) return false
        const parts = relative(source, path).split(sep)
        // build-script 元数据包含旧任务的绝对 OUT_DIR，必须在新目录重新生成。
        if (parts.includes('.fingerprint') && name.startsWith('run-build-script-')) return false
        const build = parts.indexOf('build')
        return !(
          build >= 0 &&
          parts.length === build + 3 &&
          ['out', 'output', 'stderr', 'root-output', 'invoked.timestamp'].includes(name)
        )
      }
    })
    copied++
  }
  return copied
}

async function main() {
  const mode = process.argv[2]
  assert.ok(['restore', 'save'].includes(mode), '未知Rust缓存阶段')
  const root = resolve(import.meta.dirname, '../..')
  const target = resolve(process.env.CARGO_TARGET_DIR)
  const cache = resolve(process.env.RUST_CACHE_STAGE)
  for (const [parent, directory] of [
    [join(root, 'temp/build'), target],
    [join(root, 'temp/cache'), cache]
  ]) {
    const path = relative(parent, directory)
    assert.ok(
      path && !isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`),
      'Rust缓存和构建必须使用项目temp内的专用子目录'
    )
  }
  if (mode === 'save') await rm(cache, { recursive: true, force: true })
  const copied =
    mode === 'restore'
      ? await transferRustCache(cache, target)
      : await transferRustCache(target, cache)
  console.log(
    `Rust缓存${mode === 'restore' ? '恢复' : '暂存'}完成：${copied} 个编译目录；未复制安装包或本次Tauri配置。`
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}
