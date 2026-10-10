import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { access, cp, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { createJiti } from 'jiti'

const execute = promisify(execFile)
const projectRoot = resolve(import.meta.dirname, '..')
const docsRoot = join(projectRoot, 'docs/pi-desk')

// 复制出的文档和示例必须只依赖已发布资料，不依赖开发仓库的工作目录。
test('主包携带统一文档，复制到独立目录后所有正文链接有效', async () => {
  const parent = join(projectRoot, 'temp/run/pidesk-docs')
  await mkdir(parent, { recursive: true })
  const run = await mkdtemp(join(parent, 'package-links-'))
  let passed = false
  try {
    const installed = join(run, 'installed/docs/pi-desk')
    await cp(docsRoot, installed, { recursive: true })
    for (const name of ['README.md', 'commands.md', 'plugins.md']) {
      const path = join(installed, name)
      const text = await readFile(path, 'utf8')
      const prose = text.replace(/^```[^\n]*\n[\s\S]*?^```\s*$/gm, '')
      for (const match of prose.matchAll(/\]\((\.\.?\/[^)#]+)(?:#[^)]*)?\)/g)) {
        const target = resolve(dirname(path), match[1])
        assert.ok(target.startsWith(installed), '文档不应指向未分发的外部资料')
        await access(target)
      }
      assert.doesNotMatch(text, /pi-desk-private|docs\/codebase|@jetcrab-private\//)
    }
    const command = process.platform === 'win32' ? 'npm.cmd' : 'npm'
    const { stdout } = await execute(command, ['pack', '--dry-run', '--ignore-scripts', '--json'], {
      cwd: projectRoot,
      timeout: 120_000,
      maxBuffer: 16 * 1024 * 1024,
      shell: process.platform === 'win32',
      windowsHide: true
    })
    const files = new Set(JSON.parse(stdout)[0].files.map((file) => file.path))
    for (const path of [
      'README.md',
      'commands.md',
      'plugins.md',
      'examples/local-application/package.json',
      'examples/local-application/pi-desk.ts',
      'examples/local-application/browser/entry.js',
      'examples/local-application/browser/application.js'
    ]) {
      assert.ok(files.has(`docs/pi-desk/${path}`), `npm 包缺少 ${path}`)
    }
    passed = true
  } finally {
    if (passed) await rm(run, { recursive: true, force: true })
    else console.error(`文档随包检查失败现场：${run}`)
  }
})

test('最小本地应用复制后无需安装依赖即可加载 Node 与 Browser Entry', async () => {
  const parent = join(projectRoot, 'temp/run/pidesk-docs')
  await mkdir(parent, { recursive: true })
  const run = await mkdtemp(join(parent, 'local-example-'))
  let passed = false
  try {
    const example = join(run, 'local-application')
    await cp(join(docsRoot, 'examples/local-application'), example, { recursive: true })
    const manifest = JSON.parse(await readFile(join(example, 'package.json'), 'utf8'))
    assert.equal(manifest.private, true)
    assert.deepEqual(Object.keys(manifest.dependencies ?? {}), [])
    assert.deepEqual(Object.keys(manifest.devDependencies ?? {}), [])
    await assert.rejects(access(join(example, 'node_modules')), { code: 'ENOENT' })
    const jiti = createJiti(import.meta.url, { moduleCache: false })
    const definition = await jiti.import(join(example, manifest.piDesk.entry), { default: true })
    const methods = new Map()
    let resource
    const dispose = await definition.setup({
      registerMethod(name, handler) {
        methods.set(name, handler)
      },
      registerBrowserEntry(path) {
        resource = path
      }
    })
    assert.deepEqual(
      await methods.get('status-get')({}, { signal: new AbortController().signal }),
      {
        message: '插件服务已连接'
      }
    )
    assert.equal(resource, './browser/entry.js')
    const register = (await import(pathToFileURL(join(example, resource)).href)).default
    const contributions = []
    const release = register({
      registerContribution(kind, name, value) {
        contributions.push({ kind, name, value })
      }
    })
    assert.equal(contributions.length, 1)
    assert.equal(contributions[0].kind, 'application')
    assert.equal(contributions[0].value.label, '本地应用示例')
    assert.equal(typeof contributions[0].value.load, 'function')
    await release?.()
    await dispose?.()
    passed = true
  } finally {
    if (passed) await rm(run, { recursive: true, force: true })
    else console.error(`最小示例检查失败现场：${run}`)
  }
})
