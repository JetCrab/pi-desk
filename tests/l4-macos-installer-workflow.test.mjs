import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { parse } from 'yaml'

const root = new URL('../', import.meta.url)

test('macOS 本地与 CI 均分发离线安装器，验收最终 DMG 内的安装器与主应用', async () => {
  const workflow = parse(
    await readFile(new URL('.github/workflows/release-apple.yml', root), 'utf8')
  )
  const steps = workflow.jobs.macos.steps
  const build = steps.find((step) => step.run?.includes('node scripts/build-macos-installer.mjs'))
  assert.ok(build)
  assert.match(build.run, /--target universal-apple-darwin --bundles app/)
  assert.match(build.run, /bundle\/macos\/Pi Desk\.app/)
  const regression = steps.findIndex((step) => step.run === 'pnpm run test:installer:mac')
  assert.ok(regression >= 0 && regression < steps.indexOf(build))
  const verification = steps.find((step) => step.run?.includes('pack-client.mjs'))
  assert.match(verification.run, /Pi Desk Installer\.app/)
  assert.match(verification.run, /PayloadSHA256/)
  assert.match(verification.run, /ditto -x -k/)
  assert.match(verification.run, /for bundle in "\$app" "\$installer"/)
  assert.match(
    verification.run,
    /lipo "\$installer\/Contents\/MacOS\/PiDeskInstaller" -verify_arch arm64 x86_64/
  )
  const manifest = JSON.parse(await readFile(new URL('apps/desktop/package.json', root), 'utf8'))
  assert.match(
    manifest.scripts['build:mac'],
    /--bundles app && node scripts\/build-macos-installer\.mjs/
  )
  assert.equal(manifest.scripts['test:installer:mac'], 'node scripts/test-macos-installer.mjs')
})
