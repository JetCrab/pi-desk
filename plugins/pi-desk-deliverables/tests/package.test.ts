import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const browserRoot = join(packageRoot, 'dist', 'browser')

test('Package 同时声明 deliverable Extension 与 Pi Desk Entry', async () => {
  const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'))
  assert.deepEqual(manifest.pi.extensions, ['./dist/index.js'])
  assert.equal(manifest.piDesk.entry, './dist/pi-desk.js')
})

test('Browser Entry 轻量处理通知并懒加载 Session Sidebar View', async () => {
  const entry = await readFile(join(browserRoot, 'entry.js'), 'utf8')
  const files = await readdir(browserRoot, { recursive: true })
  assert.ok(Buffer.byteLength(entry, 'utf8') < 20 * 1024)
  assert.match(entry, /registerContribution\("session-sidebar-tab","deliverables"/)
  assert.match(entry, /onPush/)
  assert.match(entry, /import\(/)
  assert.equal(entry.includes('react-dom'), false)
  assert.ok(files.filter((path) => path.endsWith('.js')).length > 1)
})

test('交付物源码与真实 Browser bundle 使用 standalone 图片组预览', async () => {
  const source = await readFile(join(packageRoot, 'src', 'browser.tsx'), 'utf8')
  const files = await readdir(browserRoot, { recursive: true })
  const bundle = await Promise.all(
    files
      .filter((path) => path.endsWith('.js'))
      .map((path) => readFile(join(browserRoot, path), 'utf8'))
  ).then((contents) => contents.join('\\n'))
  assert.match(source, /target\.files\.preview\(item\.path,\s*\{\s*mode: 'standalone'/)
  assert.match(bundle, /files\.preview\([^)]*mode:"standalone"/)
  assert.match(bundle, /imagePaths:/)
})
