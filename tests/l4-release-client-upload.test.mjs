import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { packageClient } from '../.github/scripts/pack-client.mjs'
import { readClientPackage } from '../.github/scripts/upload-client.mjs'

async function fixture(context) {
  const parent = resolve('temp/tests/release-clients/upload-selection')
  await mkdir(parent, { recursive: true })
  const root = await mkdtemp(join(parent, 'artifact-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const source = join(root, 'input.bin')
  await writeFile(source, 'fixture signed binary')
  return { root, source, output: join(root, 'output') }
}

test('分发前核对正式文件命名和SHA256，拒绝被替换的内容', async (context) => {
  const { source, output } = await fixture(context)
  await packageClient({ platform: 'windows', version: '1.2.3', source, output })
  const pkg = await readClientPackage('windows', output)
  assert.equal(pkg.filename, 'pi-desk-windows-1.2.3-x86-setup.exe')
  assert.equal(pkg.version, '1.2.3')
  await writeFile(pkg.path, 'modified content')
  await assert.rejects(readClientPackage('windows', output), /摘要/)
})

test('未签名APK不能作为正式服务器下载包', async (context) => {
  const { source, output } = await fixture(context)
  await packageClient({ platform: 'android', unsigned: true, version: '1.2.3', source, output })
  assert.ok(await readFile(join(output, 'pi-desk-android-1.2.3-unsigned.apk')))
  await assert.rejects(readClientPackage('android', output), { code: 'ENOENT' })
})
