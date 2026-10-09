import { readdir, readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'

let removedFiles = 0
let removedBytes = 0

async function pruneSourceMaps(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      await pruneSourceMaps(path)
    } else if (entry.isFile() && entry.name.endsWith('.map')) {
      const sourceMap = JSON.parse(await readFile(path, 'utf8'))
      if (sourceMap.version !== 3 || !Array.isArray(sourceMap.sources)) {
        throw new Error(`文件不是可删除的 source map：${path}`)
      }
      removedBytes += (await stat(path)).size
      await rm(path)
      removedFiles++
    }
  }
}

await pruneSourceMaps('/opt/pi-desk/node_modules')
console.info(
  `已移除 ${removedFiles} 个调试映射文件，共 ${removedBytes} 字节；保留运行代码与许可证。`
)
