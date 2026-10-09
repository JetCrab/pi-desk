import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { restoreDevPackages } from '../.github/scripts/release-dev-reuse.mjs'

async function fixture(t) {
  const parent = resolve('temp/tests/dev-reuse/registry-original')
  await mkdir(parent, { recursive: true })
  const root = await mkdtemp(join(parent, 'repo-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const git = (...args) =>
    execFileSync(
      'git',
      ['-c', 'commit.gpgSign=false', '-c', `core.hooksPath=${root}/no-hooks`, ...args],
      { cwd: root, encoding: 'utf8', stdio: 'pipe' }
    ).trim()
  git('init', '-b', 'dev')
  git('config', 'user.name', 'Fixture')
  git('config', 'user.email', 'fixture@example.test')
  await mkdir(join(root, 'src'))
  await writeFile(join(root, 'src/main.ts'), 'export const value = 1\n')
  const manifest = {
    name: '@jetcrab/pi-desk',
    version: '1.2.3',
    publishConfig: { access: 'public', registry: 'https://registry.npmjs.org' }
  }
  await writeFile(join(root, 'package.json'), JSON.stringify(manifest))
  git('add', 'package.json', 'src')
  git('commit', '-m', 'fixture')
  const oldSource = git('rev-parse', 'HEAD')
  await writeFile(join(root, 'README.md'), '测试修正，不改变制品\n')
  git('add', 'README.md')
  git('commit', '-m', 'test: 修正验收')
  const source = git('rev-parse', 'HEAD')
  const batch = {
    runId: '124',
    source,
    selected: ['pi-desk'],
    versions: { 'pi-desk': '1.2.3' },
    npmVersions: { 'pi-desk': '1.2.3-dev' }
  }
  const old = { ...batch, runId: '123', source: oldSource }
  const encode = (value) => ({
    encoding: 'base64',
    content: Buffer.from(JSON.stringify(value)).toString('base64')
  })
  const github = {
    async request(path) {
      if (path.startsWith('/contents/dev/artifact-sources.json'))
        return encode({ 'pi-desk': '123' })
      if (path.startsWith('/contents/dev/batches/123.json')) return encode(old)
      if (path.startsWith('/actions/runs/123/artifacts')) return { total_count: 0, artifacts: [] }
      throw Error('未预期接口：' + path)
    }
  }
  const archives = join(root, 'temp/archives')
  await mkdir(join(archives, 'package'), { recursive: true })
  await writeFile(
    join(archives, 'package/package.json'),
    JSON.stringify({ ...manifest, version: '1.2.3-dev' })
  )
  const filename = 'jetcrab-pi-desk-1.2.3-dev.tgz'
  execFileSync(process.platform === 'win32' ? 'tar.exe' : 'tar', ['-czf', filename, 'package'], {
    cwd: archives,
    stdio: 'pipe'
  })
  const bytes = await readFile(join(archives, filename))
  let requests = 0
  t.mock.method(console, 'info', (message) => t.diagnostic(message))
  t.mock.method(globalThis, 'fetch', async (url) => {
    requests++
    if (String(url).endsWith('.tgz')) return new Response(bytes)
    return Response.json({
      name: manifest.name,
      version: '1.2.3-dev',
      dist: {
        tarball: 'https://registry.npmjs.org/fixture.tgz',
        integrity: 'sha512-' + createHash('sha512').update(bytes).digest('base64')
      }
    })
  })
  return {
    root,
    git,
    github,
    batch,
    bytes,
    filename,
    requests: () => requests,
    directory: join(root, 'temp/restored')
  }
}

test('旧Actions制品过期时恢复Registry原字节，同版本不重新打包', async (t) => {
  const f = await fixture(t)
  const options = {
    github: f.github,
    batch: f.batch,
    directory: f.directory,
    repository: 'fixture/repo'
  }
  assert.deepEqual(await restoreDevPackages(f.root, options), ['pi-desk'])
  assert.deepEqual(await readFile(join(f.directory, f.filename)), f.bytes)
  await writeFile(join(f.directory, f.filename), 'different bytes')
  await assert.rejects(restoreDevPackages(f.root, options), /拒绝覆盖/)
  assert.equal(await readFile(join(f.directory, f.filename), 'utf8'), 'different bytes')
})

test('源码生产变化没有升版时，先拒绝复用而不是下载旧包掩盖变化', async (t) => {
  const f = await fixture(t)
  await writeFile(join(f.root, 'src/main.ts'), 'export const value = 2\n')
  f.git('add', 'src')
  f.git('commit', '-m', 'fix: 漏升版')
  await assert.rejects(
    restoreDevPackages(f.root, {
      github: f.github,
      batch: { ...f.batch, source: f.git('rev-parse', 'HEAD') },
      directory: f.directory,
      repository: 'fixture/repo'
    }),
    /版本|升版/
  )
  assert.equal(f.requests(), 0)
})

test('Registry原始制品摘要不符时拒绝恢复', async (t) => {
  const f = await fixture(t)
  t.mock.method(globalThis, 'fetch', async (url) =>
    String(url).endsWith('.tgz')
      ? new Response('tampered')
      : Response.json({
          name: '@jetcrab/pi-desk',
          version: '1.2.3-dev',
          dist: {
            tarball: 'https://registry.npmjs.org/fixture.tgz',
            integrity: 'sha512-' + createHash('sha512').update(f.bytes).digest('base64')
          }
        })
  )
  await assert.rejects(
    restoreDevPackages(f.root, {
      github: f.github,
      batch: f.batch,
      directory: f.directory,
      repository: 'fixture/repo'
    }),
    /完整性不匹配/
  )
})
