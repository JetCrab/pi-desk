import assert from 'node:assert/strict'
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import test from 'node:test'
import {
  L4PiPluginBrowserResourceNotFoundError,
  L4PiPluginBrowserResourceRegistry
} from '../src/server/l4_foundation/pi/l4-pi-plugin-browser-resource'
import { captureL4PiBrowserModules } from '../src/server/l4_foundation/pi/l4-pi-plugin-browser-snapshot'
import type { L4PiBrowserModuleSnapshot } from '../src/server/l4_foundation/pi/l4-pi-plugin-browser-snapshot'

const root = resolve(
  process.env.PI_DESK_APPLY_FIXTURE_ROOT ?? 'temp/pi/plugin-browser-resource-test',
  String(process.pid)
)

async function readText(
  registry: L4PiPluginBrowserResourceRegistry,
  resourceGroup: string,
  resourcePath: string
): Promise<string> {
  return new Response((await registry.read(resourceGroup, resourcePath)).stream).text()
}

test('资源组读取不可变JS快照，resourceKey变化后新旧URL分别返回对应版本', async (context) => {
  const browserRoot = join(root, 'browser')
  const outsideRoot = join(root, 'outside')
  const entryPath = join(browserRoot, 'entry.js')
  const chunkPath = join(browserRoot, 'chunks', 'view.js')
  await mkdir(join(browserRoot, 'chunks'), { recursive: true })
  await mkdir(outsideRoot, { recursive: true })
  await writeFile(entryPath, 'export default 1\n', 'utf8')
  await writeFile(chunkPath, 'export const view = 1\n', 'utf8')
  await writeFile(join(outsideRoot, 'secret.js'), 'secret\n', 'utf8')
  await symlink(outsideRoot, join(browserRoot, 'chunks', 'outside'), 'junction')
  await writeFile(join(root, 'secret.js'), 'secret\n', 'utf8')
  context.after(() => rm(root, { recursive: true, force: true }))

  const registry = new L4PiPluginBrowserResourceRegistry()
  context.after(() => registry.dispose())
  const firstSnapshot = await captureL4PiBrowserModules(entryPath)
  const first = registry.replace([
    {
      pluginName: 'fixture-plugin',
      entryPath,
      resourceKey: 'generation-1',
      snapshot: firstSnapshot
    }
  ])[0]!
  const repeated = registry.replace([
    {
      pluginName: 'fixture-plugin',
      entryPath,
      resourceKey: 'generation-1',
      snapshot: firstSnapshot
    }
  ])[0]!
  assert.equal(repeated.resourceGroup, first.resourceGroup)
  assert.equal(repeated.url, first.url)
  const firstEntry = await registry.read(first.resourceGroup, 'entry.js')
  const firstEntryEtag = firstEntry.etag
  assert.equal(await new Response(firstEntry.stream).text(), 'export default 1\n')
  assert.equal(
    await readText(registry, first.resourceGroup, 'chunks/view.js'),
    'export const view = 1\n'
  )
  assert.equal(firstSnapshot.modules.has('chunks/outside/secret.js'), false)

  await writeFile(entryPath, 'export default 2\n', 'utf8')
  await rm(chunkPath)
  const preservedEntry = await registry.read(first.resourceGroup, 'entry.js')
  assert.equal(preservedEntry.etag, firstEntryEtag)
  assert.equal(await new Response(preservedEntry.stream).text(), 'export default 1\n')
  assert.equal(
    await readText(registry, first.resourceGroup, 'chunks/view.js'),
    'export const view = 1\n'
  )
  await assert.rejects(
    registry.read(first.resourceGroup, '../secret.js'),
    L4PiPluginBrowserResourceNotFoundError
  )
  await assert.rejects(
    registry.read(first.resourceGroup, 'chunks/view.css'),
    L4PiPluginBrowserResourceNotFoundError
  )
  await assert.rejects(
    registry.read(first.resourceGroup, 'chunks/%2e%2e/secret.js'),
    L4PiPluginBrowserResourceNotFoundError
  )
  await assert.rejects(
    registry.read(first.resourceGroup, 'chunks/outside/secret.js'),
    L4PiPluginBrowserResourceNotFoundError
  )

  await writeFile(chunkPath, 'export const view = 2\n', 'utf8')
  const secondSnapshot = await captureL4PiBrowserModules(entryPath)
  const next = registry.replace([
    {
      pluginName: 'fixture-plugin',
      entryPath,
      resourceKey: 'generation-2',
      snapshot: secondSnapshot
    }
  ])[0]!
  assert.notEqual(next.resourceGroup, first.resourceGroup)
  assert.notEqual(next.url, first.url)
  assert.equal(await readText(registry, next.resourceGroup, 'entry.js'), 'export default 2\n')
  assert.equal(
    await readText(registry, next.resourceGroup, 'chunks/view.js'),
    'export const view = 2\n'
  )
  assert.equal(await readText(registry, first.resourceGroup, 'entry.js'), 'export default 1\n')
  assert.equal(
    await readText(registry, first.resourceGroup, 'chunks/view.js'),
    'export const view = 1\n'
  )
})

test('旧资源按TTL和组数容量淘汰，dispose清除淘汰计时器', async (context) => {
  const originalNow = Date.now
  let now = originalNow()
  Date.now = () => now
  const registry = new L4PiPluginBrowserResourceRegistry()
  context.after(() => {
    Date.now = originalNow
    registry.dispose()
  })

  const content = Buffer.from('export default 1\n')
  const snapshot: L4PiBrowserModuleSnapshot = {
    size: content.length,
    modules: new Map([
      [
        'entry.js',
        {
          content,
          etag: '"fixture-etag"'
        }
      ]
    ])
  }
  const makeEntry = (pluginName: string, resourceKey: string) => ({
    pluginName,
    entryPath: `${pluginName}/entry.js`,
    resourceKey,
    snapshot
  })
  const first = registry.replace([makeEntry('ttl-plugin', 'first')])[0]!
  registry.replace([makeEntry('ttl-plugin', 'second')])
  assert.equal(await readText(registry, first.resourceGroup, 'entry.js'), 'export default 1\n')
  now += 60_001
  await assert.rejects(
    registry.read(first.resourceGroup, 'entry.js'),
    L4PiPluginBrowserResourceNotFoundError
  )

  const entries = Array.from({ length: 33 }, (_, index) =>
    makeEntry(`capacity-plugin-${index}`, 'first')
  )
  const descriptors = registry.replace(entries)
  registry.replace([])
  const expired = await Promise.all(
    descriptors.map(async ({ resourceGroup }) => {
      try {
        await registry.read(resourceGroup, 'entry.js')
        return false
      } catch (error) {
        assert.ok(error instanceof L4PiPluginBrowserResourceNotFoundError)
        return true
      }
    })
  )
  assert.equal(expired.filter(Boolean).length, 1)

  const registryWithTimer = registry as unknown as {
    pruneTimer: ReturnType<typeof setTimeout> | null
  }
  assert.ok(registryWithTimer.pruneTimer)
  registry.dispose()
  assert.equal(registryWithTimer.pruneTimer, null)
})
