import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { createJiti } from 'jiti'
import type { L4PiPluginSource } from '../src/server/l4_foundation/pi/l4-pi-plugin-sources'

const require = createRequire(import.meta.url)

function source(name: string, version: string, path: string): L4PiPluginSource {
  return {
    source: `npm:${name}@${version}`,
    kind: 'package',
    path,
    nativePaths: [],
    piDeskRoot: null,
    version,
    description: null,
    enabled: true,
    error: null
  }
}

test('更新渠道独立、单项错误隔离，检查缓存不改变安装目标', { timeout: 30000 }, async (context) => {
  const root = resolve('temp/run/plugin-management', `channels-${randomUUID()}`)
  await mkdir(root, { recursive: true })
  let dev = '1.0.1-dev.2'
  const requested: string[] = []
  let origin = ''
  const registry = createServer((request, response) => {
    const path = decodeURIComponent(new URL(request.url!, origin).pathname)
    requested.push(path)
    const name = path.split('/').at(-1)!
    const versions = ['1.0.0', '1.0.1-dev.1', '1.0.1-dev.2', '1.0.1-dev.3', '2.0.0']
    const metadata = {
      name,
      'dist-tags': { latest: '2.0.0', ...(name === 'no-dev' ? {} : { dev }) },
      versions: Object.fromEntries(versions.map((version) => [version, { name, version }]))
    }
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify(metadata))
  })
  await new Promise<void>((done) => registry.listen(0, '127.0.0.1', done))
  const address = registry.address()
  assert.ok(address && typeof address !== 'string')
  origin = `http://127.0.0.1:${address.port}`
  const oldUserConfig = process.env.NPM_CONFIG_USERCONFIG
  const oldGlobalConfig = process.env.NPM_CONFIG_GLOBALCONFIG
  await writeFile(join(root, 'npmrc'), '')
  await writeFile(join(root, 'global-npmrc'), '')
  process.env.NPM_CONFIG_USERCONFIG = join(root, 'npmrc')
  process.env.NPM_CONFIG_GLOBALCONFIG = join(root, 'global-npmrc')
  context.after(async () => {
    if (oldUserConfig === undefined) delete process.env.NPM_CONFIG_USERCONFIG
    else process.env.NPM_CONFIG_USERCONFIG = oldUserConfig
    if (oldGlobalConfig === undefined) delete process.env.NPM_CONFIG_GLOBALCONFIG
    else process.env.NPM_CONFIG_GLOBALCONFIG = oldGlobalConfig
    await new Promise<void>((done) => {
      registry.closeAllConnections()
      registry.close(() => done())
    })
    await rm(root, { recursive: true, force: true })
  })
  const jiti = createJiti(import.meta.url, {
    tsconfigPaths: resolve('tsconfig.json'),
    nativeModules: [
      '@earendil-works/pi-coding-agent',
      '@earendil-works/pi-agent-core',
      '@earendil-works/pi-ai'
    ],
    alias: { 'server-only': join(dirname(require.resolve('server-only')), 'empty.js') }
  })
  const preferences = await jiti.import<
    typeof import('../src/server/l4_foundation/pi/l4-pi-plugin-preferences')
  >('../src/server/l4_foundation/pi/l4-pi-plugin-preferences.ts')
  const { L2PluginUpdates } = await jiti.import<
    typeof import('../src/server/l2_biz/plugin-management/l2-plugin-updates')
  >('../src/server/l2_biz/plugin-management/l2-plugin-updates.ts')
  preferences.setL4PiPluginDownloadSource({ mode: 'custom', registry: origin }, root)
  const develop = source('develop', '1.0.1-dev.1', root)
  const stable = source('stable', '1.0.0', root)
  const missing = source('no-dev', '1.0.0', root)
  preferences.setL4PiPluginUpdateTag(develop.source, 'dev', root)
  preferences.setL4PiPluginUpdateTag(missing.source, 'dev', root)
  const updates = new L2PluginUpdates(root, root, new AbortController().signal)
  const sources = [develop, stable, missing]
  const unchecked = await updates.read(sources, {})
  assert.equal(unchecked.get(develop.source)?.updateTag, 'dev')
  assert.equal(unchecked.get(develop.source)?.updateAvailable, null)
  assert.equal(requested.length, 0, '普通列表不能主动联网')

  const first = await updates.read(sources, { checkUpdates: true, tag: 'dev' })
  assert.equal(first.get(develop.source)?.availableVersion, '1.0.1-dev.2')
  assert.equal(first.get(develop.source)?.updateAvailable, true)
  assert.equal(first.get(stable.source)?.updateAvailable, null)
  assert.ok(first.get(missing.source)?.updateError)
  assert.equal(requested.includes('/stable'), false)
  const count = requested.length
  const cached = await updates.read(sources, {})
  assert.equal(requested.length, count)
  assert.equal(cached.get(develop.source)?.availableVersion, '1.0.1-dev.2')
  assert.ok(cached.get(missing.source)?.updateError, '后台刷新列表不能抹掉该项检查错误')

  dev = '1.0.1-dev.3'
  const fresh = await updates.read(sources, { checkUpdates: true, sources: ['npm:develop'] })
  assert.equal(fresh.get(develop.source)?.availableVersion, '1.0.1-dev.3')
  assert.equal(requested.length, count + 1, '主动检查选定项且绕过两层缓存')
  const noDowngrade = await updates.read([{ ...develop, version: '2.0.0' }], {})
  assert.equal(noDowngrade.get(develop.source)?.updateAvailable, false)

  preferences.setL4PiPluginUpdateTag(develop.source, 'latest', root)
  const changed = await updates.read([develop], {})
  assert.equal(changed.get(develop.source)?.availableVersion, null, '不能把dev缓存给latest渠道')
  const stableTarget = await updates.read([develop], { checkUpdates: true })
  assert.equal(stableTarget.get(develop.source)?.availableVersion, '2.0.0')
  preferences.setL4PiPluginDownloadSource({ mode: 'custom', registry: `${origin}/second` }, root)
  assert.equal((await updates.read([develop], {})).get(develop.source)?.availableVersion, null)

  preferences.setL4PiPluginUpdateTag(develop.source, 'dev', root)
  const optional = await updates.resolveInstall('npm:develop', develop.source, {}, false)
  assert.equal(optional.source, 'npm:develop@1.0.1-dev.3')
  assert.equal(optional.updateTag, 'dev')
  const newPackage = await updates.resolveInstall('npm:new-plugin', 'npm:new-plugin', {}, false)
  assert.equal(newPackage.source, 'npm:new-plugin@2.0.0')
  const exact = await updates.resolveInstall('npm:develop@1.0.0', develop.source, {}, false)
  assert.equal(exact.source, 'npm:develop@1.0.0')
  assert.equal(exact.updateTag, 'dev', '本次明确版本不应清掉后续更新渠道')
  const explicit = await updates.resolveInstall('npm:develop@latest', develop.source, {}, false)
  assert.equal(explicit.source, 'npm:develop@2.0.0')
  assert.equal(explicit.updateTag, 'latest')
  const following = await updates.resolveInstall(develop.source, develop.source, {}, true)
  assert.equal(following.source, 'npm:develop@1.0.1-dev.3', '普通更新不能沿精确旧版本重装')
  await assert.rejects(updates.resolveInstall('npm:no-dev', missing.source, {}, false), /不存在/)
})
