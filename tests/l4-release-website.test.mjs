import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { syncRelease } from '../apps/website/scripts/sync-release.mjs'
import { deploymentConfig, websiteDeployScript } from '../.github/scripts/deploy-website.mjs'
import { normalizeStaticSegments, verifyWebsite } from '../.github/scripts/build-website.mjs'

async function directory(t) {
  const parent = resolve('temp/tests/release-website/publish-sync')
  await mkdir(parent, { recursive: true })
  const root = await mkdtemp(join(parent, 'fixture-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

const record = {
  tag: 'v1.0.0',
  date: Date.parse('2026-10-08T05:00:00Z'),
  source: { base: null, head: '123456abcdef' + '0'.repeat(28) },
  packages: [{ name: '@jetcrab/pi-desk', version: '1.2.0' }],
  clients: [
    {
      platform: 'windows',
      version: '1.1.0',
      file: 'PiDesk-Windows-x86-Setup.exe',
      sha256: 'a'.repeat(64)
    },
    {
      platform: 'android',
      version: '1.0.0',
      file: 'PiDesk-Android.apk',
      sha256: 'b'.repeat(64)
    }
  ],
  changes: {
    breaking: [],
    features: [],
    added: [],
    changed: [],
    fixed: ['修复下载源选择。'],
    removed: []
  }
}

async function prepareSite(root) {
  await writeFile(
    join(root, 'site-release.json'),
    JSON.stringify({
      siteUrl: 'https://example.test',
      sourceUrl: 'https://github.com/fixture/project',
      license: { name: 'Apache-2.0', url: 'https://example.test/license' },
      installCommand: null,
      desktop: null,
      androidUrl: null
    })
  )
}

test('官网复用同一记录并同步实际安装版本与下载链接', async (t) => {
  const root = await directory(t)
  await prepareSite(root)
  const input = {
    websiteRoot: root,
    record,
    repository: 'fixture/project',
    markdown: `## ${record.tag}\n\n### Fixed\n- 修复下载源选择。\n`
  }
  const result = await syncRelease(input)
  assert.ok(result.changelogPath.endsWith('2026-10-08-130000-v1.0.0.md'))
  assert.equal(await readFile(result.changelogPath, 'utf8'), input.markdown)
  const site = JSON.parse(await readFile(result.siteReleasePath, 'utf8'))
  assert.equal(
    site.desktop.url,
    `https://github.com/fixture/project/releases/download/${record.tag}/PiDesk-Windows-x86-Setup.exe`
  )
  assert.ok(site.androidUrl.endsWith('/PiDesk-Android.apk'))
  assert.equal(site.installCommand, 'npm install -g @jetcrab/pi-desk@1.2.0')
  assert.equal(site.siteUrl, 'https://example.test')
  assert.equal(site.license.name, 'Apache-2.0')
  assert.deepEqual(await syncRelease(input), result)
  await assert.rejects(
    syncRelease({ ...input, markdown: input.markdown + '- 不同说明\n' }),
    /拒绝覆盖/
  )
  assert.equal(await readFile(result.changelogPath, 'utf8'), input.markdown)
})

test('官网无主包更新时也移除旧安装命令中的下载源', async (t) => {
  const root = await directory(t)
  await prepareSite(root)
  const configPath = join(root, 'site-release.json')
  const config = JSON.parse(await readFile(configPath, 'utf8'))
  config.installCommand =
    'npm install -g @jetcrab/pi-desk@1.1.0 --registry=https://registry.npmjs.org'
  await writeFile(configPath, JSON.stringify(config))
  await syncRelease({
    websiteRoot: root,
    record: { ...record, packages: [] },
    repository: 'fixture/project',
    markdown: '## fixture\n'
  })
  assert.equal(
    JSON.parse(await readFile(configPath, 'utf8')).installCommand,
    'npm install -g @jetcrab/pi-desk@1.1.0'
  )
})

test('官网拒绝路径逃逸与未固定的主包开发版本', async (t) => {
  const root = await directory(t)
  await prepareSite(root)
  const input = {
    websiteRoot: root,
    record,
    repository: 'fixture/project',
    markdown: '## fixture\n'
  }
  await assert.rejects(syncRelease({ ...input, record: { ...record, tag: '../escape' } }))
  await assert.rejects(
    syncRelease({
      ...input,
      record: { ...record, clients: [{ platform: 'windows', file: '../key.pem' }] }
    })
  )
  await assert.rejects(
    syncRelease({
      ...input,
      record: { ...record, packages: [{ name: '@jetcrab/pi-desk', version: '1.2.0-dev.3' }] }
    }),
    /正式版本/
  )
})

test('静态分段规范化并要求产物确实包含本批日志', async (t) => {
  const root = await directory(t)
  await mkdir(join(root, 'docs'), { recursive: true })
  await mkdir(join(root, 'changelog/__next.changelog'), { recursive: true })
  for (const file of ['index.html', 'docs/index.html', '404.html'])
    await writeFile(join(root, file), 'fixture')
  await writeFile(join(root, 'changelog/index.html'), record.tag)
  await writeFile(join(root, 'changelog/__next.changelog/__PAGE__.txt'), 'rsc fixture')
  assert.equal(await normalizeStaticSegments(root), 1)
  await verifyWebsite(root, record.tag)
  assert.equal(
    await readFile(join(root, 'changelog/__next.changelog.__PAGE__.txt'), 'utf8'),
    'rsc fixture'
  )
  await assert.rejects(verifyWebsite(root, 'v1.0.1'), /缺少本次/)
  await writeFile(join(root, 'auth.json'), '{}')
  await assert.rejects(verifyWebsite(root, record.tag), /私有配置/)
})

test('官网部署配置只允许限定应用目录与HTTPS入口', () => {
  const env = {
    WEBSITE_SSH_HOST: 'example.test',
    WEBSITE_SSH_USER: 'deploy',
    WEBSITE_SSH_KNOWN_HOSTS: 'fixture-host-key',
    WEBSITE_ROOT: '/home/apps/site',
    WEBSITE_URL: 'https://example.test',
    WEBSITE_SSH_PRIVATE_KEY: 'fixture-key'
  }
  assert.equal(deploymentConfig(env).port, 22)
  for (const extra of [
    { WEBSITE_ROOT: '/' },
    { WEBSITE_ROOT: '/home/apps/../etc' },
    { WEBSITE_URL: 'http://example.test' },
    { WEBSITE_URL: 'https://user:password@example.test' },
    { WEBSITE_SSH_HOST: 'host; echo bad' },
    { WEBSITE_SSH_PORT: '0' }
  ])
    assert.throws(() => deploymentConfig({ ...env, ...extra }))
  assert.match(websiteDeployScript, /grep -Fwq "\$tag"/)
  assert.match(websiteDeployScript, /rsync -a --delete "\$backup\/" "\$root\/data\/"/)
  assert.doesNotMatch(websiteDeployScript, /docker|nginx -s|set -x/)
})

test('主发布把模型和部署凭据分开，不开放PR特权入口', async () => {
  const main = await readFile(
    new URL('../.github/workflows/release-main.yml', import.meta.url),
    'utf8'
  )
  const dev = await readFile(
    new URL('../.github/workflows/release-dev.yml', import.meta.url),
    'utf8'
  )
  assert.match(main, /branches: \[main\]/)
  assert.doesNotMatch(main, /pull_request_target|secrets: inherit|environment:\s*production/)
  const modelStep = main.slice(main.indexOf('name: 作者和审核者'), main.indexOf('name: 固定已核验'))
  assert.match(modelStep, /RELEASE_MODEL_API_KEY/)
  assert.doesNotMatch(modelStep, /GH_TOKEN|WEBSITE_SSH|ANDROID_.*PASSWORD/)
  assert.match(dev, /contents: read/)
  assert.doesNotMatch(
    dev,
    /contents: write|WEBSITE_SSH|RELEASE_MODEL_API_KEY|upload_server: true|distribute: true/
  )
  assert.match(dev, /NPM_TOKEN: \$\{\{ secrets.NPM_TOKEN \}\}/)
})
