import { build } from 'esbuild'
import { rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sourceRoot = join(packageRoot, 'src')
const runtimeRoot = join(packageRoot, 'dist', 'host-runtime')

await rm(runtimeRoot, { recursive: true, force: true })

const commonOptions = {
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  minify: true,
  legalComments: 'eof',
  sourcemap: false,
  outdir: runtimeRoot,
  entryNames: '[name]',
  chunkNames: 'chunks/[name]-[hash]'
}

await build({
  ...commonOptions,
  entryPoints: [join(sourceRoot, 'host-runtime', 'base.ts')]
})

await build({
  ...commonOptions,
  entryPoints: [join(sourceRoot, 'host-runtime', 'markdown.ts')],
  external: ['react', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'react-dom', 'react-dom/client']
})
