import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { restoreSdkArchive } from '../.github/scripts/restore-sdk.mjs'
import { readNpmArchiveManifest } from '../.github/scripts/release-npm.mjs'

test('SDK制品可从含空格目录恢复到独立路径', async (t) => {
  const parent = resolve('temp/tests/restore-sdk/windows-paths')
  await mkdir(parent, { recursive: true })
  const root = await mkdtemp(join(parent, 'sdk-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const source = join(root, 'archive source')
  await mkdir(join(source, 'package/dist'), { recursive: true })
  await writeFile(join(source, 'package/dist/index.js'), 'export const sdk = true\n')
  const manifest = { name: '@jetcrab/pi-desk-sdk', version: '1.1.0' }
  await writeFile(join(source, 'package/package.json'), JSON.stringify(manifest))
  const tar = process.platform === 'win32' ? 'tar.exe' : 'tar'
  execFileSync(tar, ['-czf', 'sdk.tgz', 'package'], { cwd: source, stdio: 'pipe' })
  assert.deepEqual(readNpmArchiveManifest(join(source, 'sdk.tgz')), manifest)
  const destination = join(root, 'workspace/plugins/sdk')
  await restoreSdkArchive(join(source, 'sdk.tgz'), destination)
  assert.equal(
    await readFile(join(destination, 'dist/index.js'), 'utf8'),
    'export const sdk = true\n'
  )
})
