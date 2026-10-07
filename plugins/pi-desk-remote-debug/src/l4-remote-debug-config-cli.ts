import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import {
  remoteDebugProjectSaveSchema,
  remoteDebugRangesSchema
} from './l4-remote-debug-contract.js'
import { RemoteDebugSettingsStore } from './l4-remote-debug-settings.js'

const projectFileSchema = z.strictObject({
  profiles: remoteDebugProjectSaveSchema.shape.profiles
})

export async function main(args: readonly string[] = process.argv.slice(2)): Promise<void> {
  const store = new RemoteDebugSettingsStore()
  const [command, ...values] = args
  let result: unknown
  if (command === 'show' && values.length === 0) {
    result = await store.get()
  } else if (command === 'sync' && values.length > 0) {
    for (const cwd of values) await store.syncProject(cwd)
    result = await store.get()
  } else if (command === 'save' && values.length === 2) {
    const draft = projectFileSchema.parse(await readJson(values[1]!))
    result = await store.saveProject({ cwd: values[0]!, ...draft })
  } else if (command === 'ranges' && values.length === 1) {
    result = await store.saveRanges(remoteDebugRangesSchema.parse(await readJson(values[0]!)))
  } else {
    throw new Error(
      '用法：show；sync <项目目录> [项目目录...]；save <项目目录> <JSON文件>；ranges <JSON文件>'
    )
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown
  } catch (error) {
    throw new Error(
      `无法读取 JSON 文件 ${path}：${error instanceof Error ? error.message : String(error)}`
    )
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(`远程调试配置操作失败：${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
}
