import { execFileSync } from 'node:child_process'
import { copyFile, mkdir, mkdtemp } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import esbuild from 'esbuild'

if (process.platform !== 'darwin')
  throw new Error('此回归需要 macOS WKWebView 和 Xcode Command Line Tools。')

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const environment = process.argv.includes('--environment')
const windows = process.argv.includes('--windows')
if (windows && !environment) throw new Error('--windows 只用于环境引导的平台分支验证')
const platformArgs = windows ? ['--windows'] : []
const runs = resolve(
  root,
  `../../temp/run/desktop-webkit-${environment ? 'environment' : 'confirm'}${windows ? '-windows' : ''}`
)
await mkdir(runs, { recursive: true })
const output = await mkdtemp(resolve(runs, 'run-'))
await copyFile(resolve(root, 'web/l4-desktop-ui.css'), resolve(output, 'style.css'))
await esbuild.build({
  bundle: true,
  entryPoints: [resolve(root, `tests/l4-${environment ? 'environment' : 'confirm'}-fixture.tsx`)],
  outfile: resolve(output, 'fixture.js'),
  format: 'iife',
  platform: 'browser',
  target: 'es2021',
  minify: true,
  alias: {
    react: resolve(root, 'node_modules/react'),
    'react-dom': resolve(root, 'node_modules/react-dom')
  },
  plugins: [
    {
      name: 'isolated-tauri',
      setup(build) {
        build.onResolve({ filter: /^@tauri-apps\/api\/(core|event|app)$/ }, (args) => ({
          path: args.path,
          namespace: 'test-tauri'
        }))
        build.onLoad({ filter: /.*/, namespace: 'test-tauri' }, () => ({
          contents:
            'export const invoke = (...args) => window.__desktopTest.invoke(...args); export const listen = (...args) => window.__desktopTest.listen(...args); export const getVersion = async () => "0.0.0-test";',
          loader: 'js'
        }))
      }
    }
  ]
})
const binary = resolve(output, 'webkit-runner')
execFileSync('swiftc', [resolve(root, 'tests/l4-webkit-runner.swift'), '-o', binary], {
  stdio: 'inherit',
  timeout: 60_000
})
try {
  execFileSync(binary, [output, ...platformArgs], { stdio: 'inherit', timeout: 100_000 })
  if (process.argv.includes('--screenshots')) {
    const scenes = environment
      ? [
          ['initial', 'light', '1000'],
          ['waiting', 'light', '1000'],
          ['waiting', 'dark', '440'],
          ['waiting-large', 'light', '440'],
          ...(windows
            ? [
                ['git-waiting', 'light', '1000'],
                ['cancel-waiting', 'dark', '440'],
                ['parallel', 'light', '1000']
              ]
            : []),
          ['failure', 'dark', '440']
        ]
      : [
          ['stop', 'light', '1000'],
          ['stop', 'dark', '1000'],
          ['pi', 'light', '440'],
          ['pi', 'dark', '440']
        ]
    for (const [scene, theme, width] of scenes) {
      execFileSync(binary, [output, scene, theme, width, ...platformArgs], {
        stdio: 'inherit',
        timeout: 100_000
      })
    }
  }
} finally {
  console.info(`隔离验证结果：${output}`)
}
