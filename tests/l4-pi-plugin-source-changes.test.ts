import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import test from 'node:test'
import {
  L4PiPluginSourceChanges,
  L4PiPluginSourceNotFoundError
} from '../src/server/l4_foundation/pi/l4-pi-plugin-source-changes'
import type {
  L4PiPluginSource,
  L4PiPluginSourceSnapshot
} from '../src/server/l4_foundation/pi/l4-pi-plugin-sources'

const fixtureRoot = resolve(
  process.env.PI_DESK_APPLY_FIXTURE_ROOT ?? 'temp/pi/l4-pi-plugin-source-changes-test'
)

async function createFixture(context: test.TestContext): Promise<string> {
  await mkdir(fixtureRoot, { recursive: true })
  const root = await mkdtemp(join(fixtureRoot, 'source-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  return root
}

function source(path: string, nativePaths: string[] = []): L4PiPluginSource {
  return {
    source: path,
    kind: 'extension',
    path,
    nativePaths,
    piDeskRoot: null,
    version: '1.0.0',
    description: null,
    enabled: true,
    error: null
  }
}

function snapshot(sources: L4PiPluginSource[], errors: string[] = []): L4PiPluginSourceSnapshot {
  return { sources, errors }
}

test('文件与目录源码指纹捕获代码变化但不依赖版本号', async (context) => {
  const root = await createFixture(context)
  const filePath = join(root, 'single.ts')
  await writeFile(filePath, 'export const value = 1\n')
  const fileChanges = new L4PiPluginSourceChanges()
  await fileChanges.initialize(snapshot([source(filePath)]))
  assert.deepEqual(await fileChanges.scan(snapshot([source(filePath)])), [])

  await writeFile(filePath, 'export const value = 2\n')
  const fileChange = (await fileChanges.scan(snapshot([source(filePath)])))[0]
  assert.ok(fileChange)
  assert.equal(fileChange.current?.version, '1.0.0')

  const directory = join(root, 'directory-plugin')
  await mkdir(directory)
  await writeFile(join(directory, 'entry.ts'), 'export const entry = 1\n')
  await writeFile(join(directory, 'helper.ts'), 'export const helper = 1\n')
  const directorySource = source(directory)
  const directoryChanges = new L4PiPluginSourceChanges()
  await directoryChanges.initialize(snapshot([directorySource]))
  assert.deepEqual(await directoryChanges.scan(snapshot([directorySource])), [])

  await writeFile(join(directory, 'helper.ts'), 'export const helper = 2\n')
  const helperChange = (await directoryChanges.scan(snapshot([directorySource])))[0]
  assert.ok(helperChange)
  assert.equal(helperChange.current?.version, '1.0.0')
  directoryChanges.commit(helperChange)
  assert.deepEqual(await directoryChanges.scan(snapshot([directorySource])), [])

  await writeFile(join(directory, 'added.ts'), 'export const added = true\n')
  const added = (await directoryChanges.scan(snapshot([directorySource])))[0]
  assert.ok(added)
  directoryChanges.commit(added)
  await rm(join(directory, 'added.ts'))
  assert.ok((await directoryChanges.scan(snapshot([directorySource])))[0])
})

test('显式请求强制返回未变化来源，失败后未提交的变化仍可发现', async (context) => {
  const root = await createFixture(context)
  const filePath = join(root, 'entry.mjs')
  await writeFile(filePath, 'export default 1\n')
  const item = source(filePath)
  const changes = new L4PiPluginSourceChanges()
  await changes.initialize(snapshot([item]))

  assert.equal((await changes.scan(snapshot([item]), [item.source])).length, 1)
  assert.deepEqual(await changes.scan(snapshot([item])), [])

  await writeFile(filePath, 'export default 2\n')
  const failedAttempt = (await changes.scan(snapshot([item])))[0]
  assert.ok(failedAttempt)
  assert.ok((await changes.scan(snapshot([item])))[0])
  changes.commit(failedAttempt)
  assert.deepEqual(await changes.scan(snapshot([item])), [])
  await assert.rejects(
    changes.scan(snapshot([item]), ['missing-source']),
    L4PiPluginSourceNotFoundError
  )
})

test('仅完整发现确认删除，局部发现错误不卸载消失来源', async (context) => {
  const root = await createFixture(context)
  const filePath = join(root, 'entry.ts')
  await writeFile(filePath, 'export default 1\n')
  const item = source(filePath)
  const changes = new L4PiPluginSourceChanges()
  await changes.initialize(snapshot([item]))

  assert.deepEqual(await changes.scan(snapshot([], ['temporary discovery error'])), [])
  const deletion = (await changes.scan(snapshot([])))[0]
  assert.ok(deletion)
  assert.equal(deletion.current, null)
  changes.commit(deletion)
  assert.deepEqual(await changes.scan(snapshot([])), [])
})
