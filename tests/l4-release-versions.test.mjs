import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { selectRelease } from '../.github/scripts/release-versions.mjs'

async function repository(context) {
  const parent = resolve('temp/tests/release-versions/push-selection')
  await mkdir(parent, { recursive: true })
  const root = await mkdtemp(join(parent, 'repository-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const git = (...args) =>
    execFileSync(
      'git',
      ['-c', 'core.hooksPath=' + join(root, 'no-hooks'), '-c', 'commit.gpgSign=false', ...args],
      { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
    ).trim()
  git('init', '-b', 'main')
  git('config', 'user.name', 'Fixture')
  git('config', 'user.email', 'fixture@example.test')
  async function save(path, content) {
    const destination = join(root, path)
    await mkdir(resolve(destination, '..'), { recursive: true })
    await writeFile(destination, content)
  }
  async function packageFile(name, version, extras = {}) {
    const path = name === 'pi-desk' ? 'package.json' : `plugins/${name}/package.json`
    await save(
      path,
      JSON.stringify({
        name: `@jetcrab/${name}`,
        version,
        publishConfig: { registry: 'https://registry.npmjs.org', access: 'public' },
        ...extras
      })
    )
  }
  const commit = () => {
    git('add', '.')
    git('commit', '-m', 'fixture')
    return git('rev-parse', 'HEAD')
  }
  await packageFile('pi-desk', '1.0.0')
  await packageFile('pi-desk-sdk', '1.0.0')
  await packageFile('pi-desk-usage', '1.0.0')
  await save(
    'apps/tunnel/server/Cargo.toml',
    '[package]\nname="pi-desk-tunnel-server"\nversion="1.0.0"\n'
  )
  return { root, save, packageFile, commit, before: commit() }
}

function push(before, after, ref = 'refs/heads/main') {
  return { event: 'push', ref, before, after }
}

test('源码及清单内容变化但版本不变时不选择任何发布目标', async (context) => {
  const repo = await repository(context)
  await repo.save('source.js', '// changed')
  await repo.packageFile('pi-desk-usage', '1.0.0', { description: 'changed' })
  const event = push(repo.before, repo.commit())
  assert.deepEqual(await selectRelease(repo.root, 'npm', event), [])
  assert.deepEqual(await selectRelease(repo.root, 'tunnel', event), [])
})

test('比较整次推送前后版本，只选择变化的包且SDK优先', async (context) => {
  const repo = await repository(context)
  await repo.packageFile('pi-desk-usage', '1.0.1')
  await repo.packageFile('pi-desk-sdk', '1.1.0')
  repo.commit()
  await repo.save('source.js', '// later commit without version changes')
  const after = repo.commit()
  await repo.packageFile('pi-desk', '9.0.0')
  assert.deepEqual(await selectRelease(repo.root, 'npm', push(repo.before, after)), [
    'pi-desk-sdk',
    'pi-desk-usage'
  ])
})

test('镜像仅随服务版本变化选择，不因npm版本变化触发', async (context) => {
  const repo = await repository(context)
  await repo.save(
    'apps/tunnel/server/Cargo.toml',
    '[package]\nname="pi-desk-tunnel-server"\nversion="1.0.1"\n'
  )
  const event = push(repo.before, repo.commit())
  assert.deepEqual(await selectRelease(repo.root, 'tunnel', event), ['tunnel'])
  assert.deepEqual(await selectRelease(repo.root, 'npm', event), [])
})

test('dev推送和PR不具备发布资格，手动主分支首发仍可选择', async (context) => {
  const repo = await repository(context)
  await repo.packageFile('pi-desk-usage', '1.0.1')
  const after = repo.commit()
  for (const kind of ['npm', 'tunnel']) {
    await assert.rejects(
      selectRelease(repo.root, kind, push(repo.before, after, 'refs/heads/dev')),
      /main/
    )
    await assert.rejects(
      selectRelease(repo.root, kind, { event: 'pull_request', ref: 'refs/heads/main' })
    )
  }
  assert.deepEqual(
    await selectRelease(repo.root, 'npm', {
      event: 'workflow_dispatch',
      ref: 'refs/heads/main',
      package: 'pi-desk-usage'
    }),
    ['pi-desk-usage']
  )
  assert.deepEqual(
    await selectRelease(repo.root, 'tunnel', {
      event: 'workflow_dispatch',
      ref: 'refs/heads/main'
    }),
    ['tunnel']
  )
})

test('拒绝版本回退或无效比较基线，不把查询失败当作首次发布', async (context) => {
  const repo = await repository(context)
  await repo.packageFile('pi-desk-sdk', '0.9.0')
  const after = repo.commit()
  await assert.rejects(selectRelease(repo.root, 'npm', push(repo.before, after)), /递增/)
  await assert.rejects(selectRelease(repo.root, 'npm', push('1'.repeat(40), after)))
  assert.deepEqual(await selectRelease(repo.root, 'npm', push('0'.repeat(40), after)), [])
})

test('新增包进入该次发布候选，删除包不触发注册表删除', async (context) => {
  const repo = await repository(context)
  const manifest = await readFile(join(repo.root, 'plugins/pi-desk-usage/package.json'), 'utf8')
  await repo.save(
    'plugins/pi-desk-ctx/package.json',
    manifest.replaceAll('pi-desk-usage', 'pi-desk-ctx')
  )
  await rm(join(repo.root, 'plugins/pi-desk-usage'), { recursive: true })
  const after = repo.commit()
  assert.deepEqual(await selectRelease(repo.root, 'npm', push(repo.before, after)), ['pi-desk-ctx'])
})
