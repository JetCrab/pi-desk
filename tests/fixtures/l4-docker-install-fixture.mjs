import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { dirname, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)

export async function dockerInstallFixture(t, directory) {
  const root = join(directory, 'source')
  const archives = join(directory, 'npm')
  const context = join(directory, 'context')
  const host = {
    name: '@jetcrab/pi-desk',
    version: '1.2.3',
    dependencies: { '@jetcrab/pi-desk-sdk': '^1.1.0', 'docker-fixture-leaf': '^1.0.0' },
    devDependencies: { '@earendil-works/pi-coding-agent': '1.0.1' }
  }
  const sdk = { name: '@jetcrab/pi-desk-sdk', version: '1.1.0' }
  await mkdir(join(root, 'plugins/pi-desk-sdk'), { recursive: true })
  await mkdir(archives, { recursive: true })
  await writeFile(join(root, 'package.json'), JSON.stringify(host))
  await writeFile(join(root, 'plugins/pi-desk-sdk/package.json'), JSON.stringify(sdk))
  await cp(resolve('apps/docker'), join(root, 'apps/docker'), { recursive: true })

  async function pack(manifest, filename) {
    const packageDir = join(directory, `pack-${filename}`, 'package')
    await mkdir(packageDir, { recursive: true })
    await writeFile(join(packageDir, 'package.json'), JSON.stringify(manifest))
    const archive = join(archives, filename)
    execFileSync(
      'tar',
      ['-czf', relative(dirname(packageDir), archive).replaceAll('\\', '/'), 'package'],
      {
        cwd: dirname(packageDir)
      }
    )
    return readFile(archive)
  }
  await pack(host, 'jetcrab-pi-desk-1.2.3.tgz')
  await pack(sdk, 'jetcrab-pi-desk-sdk-1.1.0.tgz')
  const pi = {
    name: '@earendil-works/pi-coding-agent',
    version: '1.0.1',
    dependencies: { 'docker-fixture-leaf': '^1.0.0' }
  }
  const packages = [
    [pi, await pack(pi, 'pi.tgz')],
    ...(await Promise.all(
      ['1.0.0', '1.0.1'].map(async (version) => {
        const manifest = { name: 'docker-fixture-leaf', version }
        return [manifest, await pack(manifest, `leaf-${version}.tgz`)]
      })
    ))
  ]
  let newestLeaf = '1.0.0'
  const requests = []
  const server = createServer((request, response) => {
    const path = decodeURIComponent(request.url)
    requests.push(path)
    const tarball = packages.find(
      ([manifest]) => path === `/${manifest.name}-${manifest.version}.tgz`
    )
    if (tarball) {
      response.end(tarball[1])
      return
    }
    const entries = packages.filter(
      ([manifest]) =>
        path === `/${manifest.name}` &&
        (manifest.name !== 'docker-fixture-leaf' || manifest.version <= newestLeaf)
    )
    if (!entries.length) {
      response.writeHead(404).end()
      return
    }
    const versions = Object.fromEntries(
      entries.map(([manifest, bytes]) => [
        manifest.version,
        {
          ...manifest,
          dist: {
            tarball: `http://127.0.0.1:${server.address().port}/${manifest.name}-${manifest.version}.tgz`,
            integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`
          }
        }
      ])
    )
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ name: entries[0][0].name, versions }))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(async () => {
    server.closeAllConnections()
    await new Promise((resolveClose, reject) =>
      server.close((error) => (error ? reject(error) : resolveClose()))
    )
    assert.equal(server.listening, false)
  })
  const registry = `http://127.0.0.1:${server.address().port}`
  async function npm(cwd, args) {
    const npmArgs = [...args, '--no-audit', '--no-fund']
    await exec(
      process.platform === 'win32' ? 'cmd.exe' : 'npm',
      process.platform === 'win32' ? ['/d', '/s', '/c', `npm ${npmArgs.join(' ')}`] : npmArgs,
      {
        cwd,
        timeout: 30000,
        env: {
          ...process.env,
          npm_config_registry: registry,
          npm_config_cache: join(directory, 'cache'),
          npm_config_userconfig: join(directory, 'empty.npmrc')
        }
      }
    )
  }
  return {
    root,
    archives,
    context,
    npm,
    requests,
    advanceRegistry: () => {
      newestLeaf = '1.0.1'
    },
    lock: async () => {
      for (const name of ['host', 'pi']) {
        await npm(join(context, name), [
          'install',
          '--package-lock-only',
          '--omit=dev',
          '--ignore-scripts'
        ])
      }
    }
  }
}
