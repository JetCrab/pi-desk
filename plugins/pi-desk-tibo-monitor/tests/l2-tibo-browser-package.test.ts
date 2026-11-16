import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { build } from 'esbuild'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

test('环境归档分别声明Tibo配置与可选业务历史', async () => {
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  assert.deepEqual(manifest.piDesk.environment.files, [
    {
      base: 'config',
      path: 'pi-desk-tibo-monitor.json',
      format: 'json',
      secretPaths: [],
      omitPaths: ['/records', '/analysisRegion']
    },
    {
      base: 'data',
      path: 'tibo-monitor.json',
      format: 'json',
      secretPaths: []
    }
  ])
})

// 曾因 TypeScript 允许、但 Host Runtime 未导出的 ReactDOM API 导致通知 Chunk 无法加载。
test('轻量 Entry 和 Lazy Chunk 只使用真实 Host Runtime 提供的模块与导出', async () => {
  const browser = resolve(root, '../../temp/build/tibo-browser-contract/in-memory')
  const hostFiles = [
    fileURLToPath(import.meta.resolve('@jetcrab/pi-desk-sdk/host-runtime/base.js')),
    join(root, '..', 'pi-desk-sdk', 'dist', 'host-runtime', 'base.js')
  ]
  const hostExports: Set<string>[] = []
  for (const hostFile of hostFiles) {
    const host = ts.createSourceFile(
      hostFile,
      await readFile(hostFile, 'utf8'),
      ts.ScriptTarget.ES2022,
      true,
      ts.ScriptKind.JS
    )
    const names = new Set<string>()
    for (const node of host.statements) {
      if (
        ts.isExportDeclaration(node) &&
        node.exportClause &&
        ts.isNamedExports(node.exportClause)
      ) {
        for (const item of node.exportClause.elements) names.add(item.name.text)
      }
    }
    hostExports.push(names)
  }
  const exports = new Set(
    [...hostExports[0]!].filter((name) => hostExports.every((names) => names.has(name)))
  )
  assert.ok(exports.has('createRoot'), '需要先构建 SDK Host Runtime')
  const allowed = new Set([
    'react',
    'react/jsx-runtime',
    'react/jsx-dev-runtime',
    'react-dom',
    'react-dom/client',
    '@jetcrab/pi-desk-sdk/react/base'
  ])
  const result = await build({
    entryPoints: [join(root, 'src', 'l2-browser-entry.ts')],
    bundle: true,
    splitting: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    minify: true,
    define: { 'process.env.NODE_ENV': '"production"' },
    external: [...allowed],
    outdir: browser,
    entryNames: 'entry',
    chunkNames: 'chunks/[name]-[hash]',
    write: false
  })
  const files = result.outputFiles.filter((file) => file.path.endsWith('.js'))
  assert.ok(files.length > 1, 'Browser 必须保持懒加载')
  for (const output of files) {
    const path = relative(browser, output.path)
    const text = output.text
    if (path === 'entry.js') assert.ok(Buffer.byteLength(text) < 20 * 1024)
    const file = ts.createSourceFile(path, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS)
    for (const node of file.statements) {
      if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier)) continue
      const specifier = node.moduleSpecifier.text
      if (specifier.startsWith('./') || specifier.startsWith('../')) continue
      assert.notEqual(path, 'entry.js', 'Entry 不应静态加载 React/UI')
      assert.ok(allowed.has(specifier), `Host 不支持的模块：${specifier}`)
      if (node.importClause?.name) assert.ok(exports.has('default'), `${specifier} 未提供 default`)
      const bindings = node.importClause?.namedBindings
      if (bindings && ts.isNamedImports(bindings)) {
        for (const item of bindings.elements) {
          const name = (item.propertyName ?? item.name).text
          assert.ok(exports.has(name), `Host Runtime 未导出 ${specifier}.${name}（${path}）`)
        }
      }
    }
  }
})
