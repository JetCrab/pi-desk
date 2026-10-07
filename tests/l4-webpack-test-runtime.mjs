import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'

const require = createRequire(import.meta.url)
const { webpack } = require('next/dist/compiled/webpack/webpack')

export async function bundleL4ServerModule(directory, entry) {
  const loader = join(directory, 'typescript-loader.cjs')
  await mkdir(directory, { recursive: true })
  await writeFile(
    loader,
    `const ts = require(${JSON.stringify(require.resolve('typescript'))});
module.exports = function(source) {
  return ts.transpileModule(source, {
    fileName: this.resourcePath,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
  }).outputText;
};`
  )
  const compiler = webpack({
    mode: 'production',
    target: 'node22',
    context: process.cwd(),
    entry,
    output: { path: directory, filename: 'runtime.mjs', library: { type: 'module' } },
    experiments: { outputModule: true },
    // 路径改写发生在模块解析阶段；压缩插件依赖 Next 整站构建的追踪状态。
    optimization: { minimize: false },
    externalsType: 'module',
    externals: [
      ({ request }, callback) => {
        if (/^(?:@earendil-works\/|typebox(?:\/|$)|jiti$)/.test(request ?? '')) {
          callback(null, request)
        } else {
          callback()
        }
      }
    ],
    resolve: {
      extensions: ['.ts', '.js'],
      alias: { 'server-only': false, '@server': resolve('src/server') }
    },
    module: { rules: [{ test: /\.ts$/, use: loader }] }
  })
  try {
    await new Promise((resolveBuild, rejectBuild) => {
      compiler.run((error, stats) => {
        if (error) return rejectBuild(error)
        if (stats.hasErrors())
          return rejectBuild(new Error(stats.toString({ all: false, errors: true })))
        resolveBuild()
      })
    })
  } finally {
    await new Promise((resolveClose, rejectClose) => {
      compiler.close((error) => (error ? rejectClose(error) : resolveClose()))
    })
  }
}
