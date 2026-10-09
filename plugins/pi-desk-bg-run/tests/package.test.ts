import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

test('Package 保持原生 Extension，支持本地化说明并保留归属', async () => {
  const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'))
  assert.deepEqual(manifest.pi.extensions, ['./dist/index.js'])
  assert.equal(manifest.piDesk.entry, undefined)
  assert.ok(manifest.piDesk.i18n['zh-CN'].description.trim().length > 0)
  assert.equal(manifest.license, 'ISC')
  assert.equal(manifest.files.includes('LICENSE'), true)
  assert.equal(manifest.files.includes('SOURCE.md'), true)
})

test('编译产物不再依赖归档 task_ui 协议', async () => {
  const source = await readFile(join(packageRoot, 'dist', 'index.js'), 'utf8')
  assert.equal(source.includes('task_ui'), false)
  assert.equal(source.includes("name: 'bg_run'"), true)
  assert.equal(source.includes("name: 'bg_status'"), true)
  assert.equal(source.includes("name: 'bg_kill'"), true)
})

test('bg_run 编译产物保留独立工作提示并抑制连续轮询建议', async () => {
  const source = await readFile(join(packageRoot, 'dist', 'index.js'), 'utf8')
  assert.match(source, /不依赖其结果的独立工作/)
  assert.match(source, /查询状态、读取进度不算独立工作/)
  assert.match(source, /不要连续查询未变化的状态或重复读取相同日志/)
  assert.doesNotMatch(source, /仅当命令必须在主流程继续其他工作时保持运行/)
  assert.doesNotMatch(source, /bg_run 返回后，使用 bg_status 查看状态/)
})
