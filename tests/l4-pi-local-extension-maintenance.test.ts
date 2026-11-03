import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { access, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, relative, resolve } from 'node:path'
import test from 'node:test'
import { createJiti } from 'jiti'

test('本地裸扩展卸载只移除来源入口和精确声明', async (t) => {
  const root = resolve('temp/pi/l4-pi-local-extension-maintenance', `remove-${randomUUID()}`)
  const agentDir = join(root, 'agent')
  const cwd = join(root, 'project')
  const home = join(root, 'home')
  const saved = new Map<string, string | undefined>()
  let succeeded = false
  await Promise.all([
    mkdir(agentDir, { recursive: true }),
    mkdir(cwd, { recursive: true }),
    mkdir(home, { recursive: true })
  ])
  for (const [key, value] of Object.entries({
    HOME: home,
    USERPROFILE: home,
    PI_CODING_AGENT_DIR: agentDir,
    PI_CODING_AGENT_SESSION_DIR: join(agentDir, 'sessions')
  })) {
    saved.set(key, process.env[key])
    process.env[key] = value
  }
  try {
    const require = createRequire(import.meta.url)
    const jiti = createJiti(import.meta.url, {
      nativeModules: [
        '@earendil-works/pi-coding-agent',
        '@earendil-works/pi-agent-core',
        '@earendil-works/pi-ai'
      ],
      tsconfigPaths: resolve('tsconfig.json'),
      alias: { 'server-only': join(dirname(require.resolve('server-only')), 'empty.js') }
    })
    const { removeL4PiLocalExtension } = await jiti.import<
      typeof import('../src/server/l4_foundation/pi/l4-pi-local-extension-maintenance')
    >('../src/server/l4_foundation/pi/l4-pi-local-extension-maintenance.ts')
    const preferences = await jiti.import<
      typeof import('../src/server/l4_foundation/pi/l4-pi-plugin-preferences')
    >('../src/server/l4_foundation/pi/l4-pi-plugin-preferences.ts')

    const fixture = async (
      name: string
    ): Promise<{ agentDir: string; cwd: string; extensions: string; settingsPath: string }> => {
      const dir = join(root, name, 'agent')
      const extensions = join(dir, 'extensions')
      await mkdir(extensions, { recursive: true })
      return { agentDir: dir, cwd, extensions, settingsPath: join(dir, 'settings.json') }
    }

    let failed = false
    const run = async (name: string, execute: () => Promise<void>): Promise<void> => {
      await t.test(name, async () => {
        try {
          await execute()
        } catch (error) {
          failed = true
          throw error
        }
      })
    }

    await run('直接文件只删除目标并清理已有管理偏好，保留业务配置', async () => {
      const input = await fixture('direct-file')
      const target = join(input.extensions, 'target.ts')
      const other = join(input.extensions, 'other.ts')
      const business = join(input.agentDir, 'plugin-business.json')
      await Promise.all([
        writeFile(target, 'export default function () {}'),
        writeFile(other, 'other'),
        writeFile(business, '{"enabled":true}')
      ])
      const source = await realpath(target)
      preferences.setL4PiPluginEnabled(source, false, input.agentDir)
      preferences.setL4PiPluginRegistry(source, 'https://registry.example.test', input.agentDir)
      preferences.setL4PiPluginUpdateTag(source, 'dev', input.agentDir)
      preferences.setL4PiPluginEnabled(other, false, input.agentDir)
      await removeL4PiLocalExtension({ ...input, source })
      await assert.rejects(access(target), { code: 'ENOENT' })
      assert.equal(await readFile(other, 'utf8'), 'other')
      assert.equal(await readFile(business, 'utf8'), '{"enabled":true}')
      const remaining = preferences.readL4PiPluginPreferences(input.agentDir)
      assert.deepEqual(remaining.disabled, [other.replaceAll('\\', '/')])
      assert.deepEqual(remaining.registries, {})
      assert.deepEqual(remaining.updateTags, {})
      await assert.rejects(access(input.settingsPath), { code: 'ENOENT' })
    })

    await run('直接目录只删除目标树，保留同名前缀、隐藏和node_modules入口', async () => {
      const input = await fixture('direct-directory')
      const target = join(input.extensions, 'target')
      const other = join(input.extensions, 'target-other')
      await Promise.all([
        mkdir(join(target, 'nested'), { recursive: true }),
        mkdir(other, { recursive: true }),
        mkdir(join(input.extensions, 'node_modules'), { recursive: true })
      ])
      await Promise.all([
        writeFile(join(target, 'nested', 'data.txt'), 'remove'),
        writeFile(join(other, 'index.ts'), 'keep'),
        writeFile(join(input.extensions, 'node_modules', 'keep.txt'), 'keep'),
        writeFile(join(input.extensions, '.hidden.ts'), 'keep')
      ])
      await removeL4PiLocalExtension({ ...input, source: await realpath(target) })
      await assert.rejects(access(target), { code: 'ENOENT' })
      assert.equal(await readFile(join(other, 'index.ts'), 'utf8'), 'keep')
      assert.equal(
        await readFile(join(input.extensions, 'node_modules', 'keep.txt'), 'utf8'),
        'keep'
      )
      assert.equal(await readFile(join(input.extensions, '.hidden.ts'), 'utf8'), 'keep')
      await assert.rejects(access(join(input.agentDir, 'pi-desk-plugins.json')), { code: 'ENOENT' })
    })

    await run('junction多个入口只删除链接，隐藏链接和真实目标保留', async () => {
      const input = await fixture('junction')
      const external = join(root, 'junction-source')
      await mkdir(external, { recursive: true })
      await writeFile(join(external, 'index.ts'), 'keep source')
      const first = join(input.extensions, 'first')
      const second = join(input.extensions, 'second')
      const hidden = join(input.extensions, '.hidden')
      const nodeModules = join(input.extensions, 'node_modules')
      await Promise.all([
        symlink(external, first, 'junction'),
        symlink(external, second, 'junction'),
        symlink(external, hidden, 'junction'),
        symlink(external, nodeModules, 'junction')
      ])
      await writeFile(
        input.settingsPath,
        JSON.stringify({ extensions: ['extensions/first/index.ts', second], theme: 'dark' })
      )
      await removeL4PiLocalExtension({ ...input, source: await realpath(external) })
      await assert.rejects(access(first), { code: 'ENOENT' })
      await assert.rejects(access(second), { code: 'ENOENT' })
      assert.equal(await readFile(join(external, 'index.ts'), 'utf8'), 'keep source')
      assert.equal(await realpath(hidden), await realpath(external))
      assert.equal(await realpath(nodeModules), await realpath(external))
      assert.deepEqual(JSON.parse(await readFile(input.settingsPath, 'utf8')), {
        extensions: [],
        theme: 'dark'
      })
    })

    await run('外部目录精确声明按agentDir和~/解析，仅移除目标与内部声明', async () => {
      const input = await fixture('external-directory')
      const external = join(home, 'external-source')
      const other = `${external}-other.ts`
      await mkdir(external, { recursive: true })
      const entry = join(external, 'index.ts')
      await writeFile(entry, 'keep external')
      await writeFile(other, 'keep other')
      const homeReference = '~/external-source/index.ts'
      const projectSettings = join(cwd, '.pi', 'settings.json')
      const projectText = JSON.stringify({ extensions: [external], theme: 'light' })
      await mkdir(dirname(projectSettings), { recursive: true })
      await writeFile(projectSettings, projectText)
      const otherConfig = {
        theme: 'dark',
        packages: ['npm:fixture-package'],
        skills: ['./skills'],
        customBusiness: { value: 'keep' }
      }
      await writeFile(
        input.settingsPath,
        JSON.stringify({
          ...otherConfig,
          extensions: [external, relative(input.agentDir, entry), homeReference, other]
        })
      )
      await removeL4PiLocalExtension({ ...input, source: await realpath(external) })
      assert.deepEqual(JSON.parse(await readFile(input.settingsPath, 'utf8')), {
        ...otherConfig,
        extensions: [other]
      })
      assert.equal(await readFile(entry, 'utf8'), 'keep external')
      assert.equal(await readFile(other, 'utf8'), 'keep other')
      assert.equal(await readFile(projectSettings, 'utf8'), projectText)
    })

    await run('外部单文件精确引用只移除声明，保留源码与其他声明', async () => {
      const input = await fixture('external-file')
      const target = join(root, 'external-file.ts')
      await writeFile(target, 'keep external file')
      await writeFile(
        input.settingsPath,
        JSON.stringify({ extensions: [target, './unrelated.ts'], theme: 'dark' })
      )
      await removeL4PiLocalExtension({ ...input, source: await realpath(target) })
      assert.equal(await readFile(target, 'utf8'), 'keep external file')
      assert.deepEqual(JSON.parse(await readFile(input.settingsPath, 'utf8')), {
        extensions: ['./unrelated.ts'],
        theme: 'dark'
      })
    })

    await run('来源目录和extensions已消失时仍清理精确引用及管理偏好', async () => {
      const input = await fixture('missing-directory')
      const source = join(input.extensions, 'gone')
      await mkdir(source)
      const canonicalSource = await realpath(source)
      await rm(input.extensions, { recursive: true })
      await writeFile(
        input.settingsPath,
        JSON.stringify({ extensions: [canonicalSource, 'extensions/gone/index.ts', 'keep.ts'] })
      )
      preferences.setL4PiPluginEnabled(canonicalSource, false, input.agentDir)
      await removeL4PiLocalExtension({ ...input, source: canonicalSource })
      assert.deepEqual(JSON.parse(await readFile(input.settingsPath, 'utf8')).extensions, [
        'keep.ts'
      ])
      assert.deepEqual(preferences.readL4PiPluginPreferences(input.agentDir).disabled, [])
      await assert.rejects(access(input.extensions), { code: 'ENOENT' })
      const before = await readFile(input.settingsPath, 'utf8')
      await removeL4PiLocalExtension({ ...input, source: canonicalSource })
      assert.equal(await readFile(input.settingsPath, 'utf8'), before)
    })

    await run('规则前缀和模式全部保留，没有精确引用时配置字节不变', async () => {
      const input = await fixture('rules')
      const external = join(root, 'rules-source')
      await mkdir(external)
      await writeFile(join(external, 'index.ts'), 'keep')
      const rules = [
        `!${external}`,
        `+${external}`,
        `-${external}`,
        `${external}/*.ts`,
        `${external}/?.ts`,
        `${external}/{index,other}.ts`,
        `${external}/[ab].ts`,
        `${external}/@(index|other).ts`
      ]
      await writeFile(input.settingsPath, JSON.stringify({ extensions: [external, ...rules] }))
      await removeL4PiLocalExtension({ ...input, source: await realpath(external) })
      assert.deepEqual(JSON.parse(await readFile(input.settingsPath, 'utf8')).extensions, rules)
      const original = JSON.stringify({ theme: 'dark', extensions: rules }, null, 4)
      await writeFile(input.settingsPath, original)
      await removeL4PiLocalExtension({ ...input, source: await realpath(external) })
      assert.equal(await readFile(input.settingsPath, 'utf8'), original)
      assert.equal(await readFile(join(external, 'index.ts'), 'utf8'), 'keep')
    })

    await run('配置读取失败时返回中文错误并保留入口', async () => {
      const input = await fixture('invalid-settings')
      const target = join(input.extensions, 'target.ts')
      await writeFile(target, 'keep')
      await writeFile(input.settingsPath, '{invalid json')
      await assert.rejects(
        removeL4PiLocalExtension({ ...input, source: await realpath(target) }),
        /移除本地扩展失败：读取扩展配置失败/
      )
      assert.equal(await readFile(target, 'utf8'), 'keep')
      assert.equal(await readFile(input.settingsPath, 'utf8'), '{invalid json')
    })
    succeeded = !failed
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    if (succeeded) await rm(root, { recursive: true, force: true })
    else t.diagnostic(`失败现场：${root}`)
  }
})
