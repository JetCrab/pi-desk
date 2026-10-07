import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { packageClient } from '../.github/scripts/pack-client.mjs'

for (const [platform, unsigned, filename] of [
  ['windows', false, 'pi-desk-windows-1.2.3-x86-setup.exe'],
  ['android', false, 'pi-desk-android-1.2.3.apk'],
  ['android', true, 'pi-desk-android-1.2.3-unsigned.apk']
]) {
  test(`客户端制品命名和摘要：${platform} unsigned=${unsigned}`, async (context) => {
    const parent = resolve('temp/tests/release-clients/package-files')
    await mkdir(parent, { recursive: true })
    const directory = await mkdtemp(join(parent, 'artifact-'))
    context.after(() => rm(directory, { recursive: true, force: true }))
    const source = join(directory, 'fixture.bin')
    const output = join(directory, 'output')
    const bytes = Buffer.from('fixture installer content')
    await writeFile(source, bytes)
    await packageClient({ platform, unsigned, version: '1.2.3', source, output })
    assert.deepEqual(await readFile(join(output, filename)), bytes)
    assert.deepEqual(JSON.parse(await readFile(join(output, 'release.json'), 'utf8')), {
      version: '1.2.3',
      sha256: createHash('sha256').update(bytes).digest('hex')
    })
  })
}

test('拒绝未知平台和非正式版本，不生成模糊发布文件', async () => {
  await assert.rejects(
    packageClient({ platform: 'unknown', version: '1.0.0', source: 'missing', output: 'unused' })
  )
  await assert.rejects(
    packageClient({ platform: 'windows', version: '../bad', source: 'missing', output: 'unused' })
  )
})
