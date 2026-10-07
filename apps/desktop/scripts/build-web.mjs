import { mkdir, rm, copyFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import esbuild from 'esbuild'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const output = resolve(
  process.env.PI_DESK_DESKTOP_WEB_DIST || resolve(root, '../..', 'temp/build/desktop-web/local')
)

await rm(output, { recursive: true, force: true })
await mkdir(output, { recursive: true })
await copyFile(resolve(root, 'web', 'index.html'), resolve(output, 'index.html'))
await copyFile(resolve(root, 'web', 'l4-desktop-ui.css'), resolve(output, 'l4-desktop-ui.css'))
await esbuild.build({
  bundle: true,
  entryPoints: [resolve(root, 'web', 'l1-desktop-main.tsx')],
  format: 'iife',
  outfile: resolve(output, 'l1-desktop-main.js'),
  platform: 'browser',
  target: 'es2021',
  minify: true
})
