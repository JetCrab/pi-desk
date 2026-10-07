import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'
import { createRequire } from 'node:module'
import { createJiti } from 'jiti'

type PiModule = typeof import('@earendil-works/pi-coding-agent')
type ResourcesModule = typeof import('../src/server/l4_foundation/pi/l4-pi-session-resources')
const require = createRequire(import.meta.url)
const jiti = createJiti(import.meta.url, {
  moduleCache: false,
  alias: { 'server-only': join(dirname(require.resolve('server-only')), 'empty.js') }
})

async function write(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content)
}

test('会话直接加载原目录资源、保持实例状态独立并支持重载', async () => {
  const root = join(
    fileURLToPath(new URL('..', import.meta.url)),
    'temp/pi/l4-session-resources',
    `direct-loading-${randomUUID()}`
  )
  const agentDir = join(root, 'agent')
  const cwd = join(root, 'project')
  const pkg = join(root, 'fixture')
  const previous = process.env.PI_CODING_AGENT_DIR
  const previousSessionDir = process.env.PI_CODING_AGENT_SESSION_DIR
  const bundledResources = process.env.PI_DESK_TEST_RESOURCE_BUNDLE
  const [{ createEventBus }, { L4PiSessionResources }] = await Promise.all([
    jiti.import<PiModule>('@earendil-works/pi-coding-agent'),
    bundledResources
      ? (import(bundledResources) as Promise<ResourcesModule>)
      : jiti.import<ResourcesModule>('../src/server/l4_foundation/pi/l4-pi-session-resources.ts')
  ])
  const resourcesA = new L4PiSessionResources()
  const resourcesB = new L4PiSessionResources()
  const a = createEventBus()
  const b = createEventBus()
  let passed = false
  try {
    await mkdir(cwd, { recursive: true })
    process.env.PI_CODING_AGENT_DIR = agentDir
    process.env.PI_CODING_AGENT_SESSION_DIR = join(agentDir, 'sessions')
    await write(join(agentDir, 'settings.json'), JSON.stringify({ packages: [pkg] }))
    await write(
      join(pkg, 'package.json'),
      JSON.stringify({
        name: 'fixture',
        type: 'module',
        dependencies: { 'private-helper': '1.0.0' },
        pi: { extensions: ['./index.mjs'], skills: ['./skills'], prompts: ['./prompts'] }
      })
    )
    await write(
      join(pkg, 'node_modules/private-helper/package.json'),
      JSON.stringify({
        name: 'private-helper',
        main: 'index.cjs'
      })
    )
    await write(
      join(pkg, 'node_modules/private-helper/index.cjs'),
      'module.exports = { value: 42, path: __filename }'
    )
    const update = async (version: number): Promise<void> => {
      await write(join(pkg, 'late.mjs'), `export default ${version}`)
      await write(
        join(pkg, 'skills/example/SKILL.md'),
        `---\nname: example\ndescription: Fixture\n---\nversion ${version}\n`
      )
      await write(
        join(pkg, 'prompts/example.md'),
        `---\ndescription: Fixture\n---\nversion ${version}\n`
      )
      await write(
        join(pkg, 'index.mjs'),
        `
        import dependency from 'private-helper'
        import { readFileSync } from 'node:fs'
        export default (pi) => {
          let reads = 0
          pi.events.on('fixture:read', async () => {
            const late = await import('./late.mjs')
            pi.events.emit('fixture:result', {
              entry: ${version}, dependency, late: late.default, reads: ++reads,
              entryUrl: import.meta.url,
              text: readFileSync(new URL('./skills/example/SKILL.md', import.meta.url), 'utf8')
            })
          })
        }
      `
      )
    }
    const inspect = (bus: ReturnType<typeof createEventBus>): Promise<unknown> =>
      new Promise((done) => {
        const unsubscribe = bus.on('fixture:result', (value) => {
          unsubscribe()
          done(value)
        })
        bus.emit('fixture:read', {})
      })
    await update(1)
    const first = await resourcesA.createServices(cwd, { eventBus: a })
    assert.deepEqual(first.resourceLoader.getExtensions().errors, [])
    const skillA = first.resourceLoader.getSkills().skills.find((skill) => skill.name === 'example')
    assert.ok(skillA)
    assert.equal(skillA.filePath, join(pkg, 'skills/example/SKILL.md'))
    assert.equal(skillA.sourceInfo?.origin, 'package')
    const promptA = first.resourceLoader
      .getPrompts()
      .prompts.find((prompt) => prompt.name === 'example')
    assert.equal(promptA?.filePath, join(pkg, 'prompts/example.md'))
    assert.equal(promptA?.sourceInfo?.origin, 'package')
    const extensionA = first.resourceLoader
      .getExtensions()
      .extensions.find((extension) => extension.path === join(pkg, 'index.mjs'))
    assert.ok(extensionA)
    assert.equal(extensionA.path, join(pkg, 'index.mjs'))
    assert.equal(extensionA.sourceInfo?.origin, 'package')
    await update(2)
    const second = await resourcesB.createServices(cwd, { eventBus: b })
    assert.deepEqual(second.resourceLoader.getExtensions().errors, [])
    const expected = {
      dependency: { value: 42, path: join(pkg, 'node_modules/private-helper/index.cjs') },
      late: 2,
      reads: 1,
      entryUrl: pathToFileURL(join(pkg, 'index.mjs')).href,
      text: '---\nname: example\ndescription: Fixture\n---\nversion 2\n'
    }
    assert.deepEqual(await inspect(a), { ...expected, entry: 1 })
    assert.deepEqual(await inspect(a), { ...expected, entry: 1, reads: 2 })
    assert.deepEqual(await inspect(b), { ...expected, entry: 2 })
    assert.match(await readFile(skillA.filePath, 'utf8'), /version 2/)
    a.clear()
    await first.resourceLoader.reload()
    assert.deepEqual(first.resourceLoader.getExtensions().errors, [])
    assert.deepEqual(await inspect(a), { ...expected, entry: 2 })
    assert.deepEqual(await inspect(b), { ...expected, entry: 2, reads: 2 })
    assert.match(first.resourceLoader.getPrompts().prompts[0].content, /version 2/)
    resourcesA.reset()
    resourcesB.reset()
    await access(skillA.filePath)
    await access(join(pkg, 'node_modules/private-helper/index.cjs'))
    await assert.rejects(access(join(agentDir, 'pi-desk/plugin-runtime')), { code: 'ENOENT' })
    passed = true
  } finally {
    a.clear()
    b.clear()
    resourcesA.reset()
    resourcesB.reset()
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previous
    if (previousSessionDir === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR
    else process.env.PI_CODING_AGENT_SESSION_DIR = previousSessionDir
    if (passed) await rm(root, { recursive: true, force: true })
    else console.error(`会话资源验证失败，现场：${root}`)
  }
})

test('官方内置扩展遵守禁用配置、重载与第三方替代', async () => {
  const root = join(
    fileURLToPath(new URL('..', import.meta.url)),
    'temp/pi/l4-session-resources',
    `builtin-selection-${randomUUID()}`
  )
  const agentDir = join(root, 'agent')
  const cwd = join(root, 'project')
  const previous = process.env.PI_CODING_AGENT_DIR
  const previousSessionDir = process.env.PI_CODING_AGENT_SESSION_DIR
  let loader: import('@earendil-works/pi-coding-agent').ResourceLoader | undefined
  let passed = false
  try {
    await mkdir(cwd, { recursive: true })
    await write(join(agentDir, 'settings.json'), '{}')
    process.env.PI_CODING_AGENT_DIR = agentDir
    process.env.PI_CODING_AGENT_SESSION_DIR = join(agentDir, 'sessions')
    const { L4PiSessionResources } = await jiti.import<ResourcesModule>(
      '../src/server/l4_foundation/pi/l4-pi-session-resources.ts'
    )
    const services = await new L4PiSessionResources().createServices(cwd, {})
    loader = services.resourceLoader
    const builtinPaths = (): string[] =>
      loader!
        .getExtensions()
        .extensions.filter((extension) => extension.path.startsWith('builtin:'))
        .map((extension) => extension.path)
        .sort()
    assert.deepEqual(loader.getExtensions().errors, [])
    assert.deepEqual(builtinPaths(), ['builtin:codemode', 'builtin:mcp', 'builtin:tool-search'])
    for (const extension of loader.getExtensions().extensions) {
      assert.equal(extension.replaceable, true)
      assert.equal(extension.sourceInfo?.source, 'builtin')
    }

    await write(
      join(agentDir, 'settings.json'),
      JSON.stringify({ extensions: ['-builtin:mcp', '-builtin:tool-search'] })
    )
    await loader.reload()
    assert.deepEqual(loader.getExtensions().errors, [])
    assert.deepEqual(builtinPaths(), ['builtin:codemode'])

    await write(join(cwd, '.pi', 'settings.json'), JSON.stringify({ extensions: ['+builtin:mcp'] }))
    await loader.reload()
    assert.deepEqual(loader.getExtensions().errors, [])
    assert.deepEqual(builtinPaths(), ['builtin:codemode', 'builtin:mcp'])

    await write(join(cwd, '.pi', 'settings.json'), '{}')
    await write(join(agentDir, 'settings.json'), '{}')
    await write(
      join(agentDir, 'extensions', 'replacement.ts'),
      `export default function (pi) {
        pi.registerCommand('mcp', { description: 'Fixture MCP', handler: async () => {} })
        pi.registerTool({
          name: 'codemode', label: 'Fixture', description: 'Fixture Codemode',
          parameters: { type: 'object', properties: {} },
          execute: async () => ({ content: [], details: {} })
        })
      }`
    )
    await loader.reload()
    assert.deepEqual(loader.getExtensions().errors, [])
    const replacement = loader
      .getExtensions()
      .extensions.find((extension) => extension.commands.has('mcp'))
    assert.equal(replacement?.path, join(agentDir, 'extensions', 'replacement.ts'))
    assert.deepEqual(builtinPaths(), ['builtin:tool-search'])
    assert.equal(replacement?.tools.has('codemode'), true)
    passed = true
  } finally {
    loader?.getExtensions().runtime.invalidate('资源测试结束')
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previous
    if (previousSessionDir === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR
    else process.env.PI_CODING_AGENT_SESSION_DIR = previousSessionDir
    if (passed) await rm(root, { recursive: true, force: true })
    else console.error(`内置资源验证失败，现场：${root}`)
  }
})
