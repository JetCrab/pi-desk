'use strict'

const { spawn } = require('node:child_process')
const { existsSync, readFileSync, realpathSync } = require('node:fs')
const { createRequire } = require('node:module')
const { tmpdir } = require('node:os')
const { isAbsolute, join } = require('node:path')
const { fileURLToPath, pathToFileURL } = require('node:url')
const { terminateManagedTree } = require('../process/l4-process-tree.js')
const { packageRoot } = require('../process/l4-package-root.js')

const PI_PACKAGE = '@earendil-works/pi-coding-agent'
const PI_RUNTIME_EXIT_CODE = 78
const INSTALL_VERSION = require(join(packageRoot, 'package.json')).devDependencies[PI_PACKAGE]
const CORE_PACKAGES = [
  PI_PACKAGE,
  '@earendil-works/pi-agent-core',
  '@earendil-works/pi-ai',
  '@earendil-works/pi-tui'
]

function npmGlobalRoot() {
  return new Promise((resolveRoot, rejectRoot) => {
    const child = spawn(
      process.platform === 'win32' ? 'cmd.exe' : 'npm',
      process.platform === 'win32' ? ['/d', '/s', '/c', 'npm root -g'] : ['root', '-g'],
      {
        cwd: tmpdir(),
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        detached: process.platform !== 'win32'
      }
    )
    let output = ''
    let errorOutput = ''
    let settled = false
    const finish = (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      void terminateManagedTree(child).then(() => {
        if (error) rejectRoot(error)
        else resolveRoot(output.trim())
      }, rejectRoot)
    }
    const timer = setTimeout(() => finish(new Error('查询 npm 全局目录超时')), 10_000)
    child.stdout.on('data', (chunk) => {
      output = `${output}${chunk}`.slice(-8192)
    })
    child.stderr.on('data', (chunk) => {
      errorOutput = `${errorOutput}${chunk}`.slice(-8192)
    })
    child.once('error', (error) => finish(new Error(`无法运行 npm：${error.message}`)))
    child.once('close', (code) =>
      finish(code === 0 ? null : new Error(`查询 npm 全局目录失败：${errorOutput.trim() || code}`))
    )
  })
}

async function findGlobalPi() {
  // 该覆盖只属于当前进程及其子进程，发布验证用隔离 npm prefix，绝不修改真实全局安装。
  const configured = process.env.PI_DESK_PI_PACKAGE_DIR
  if (configured && !isAbsolute(configured)) throw new Error('Pi 运行目录必须是绝对路径')
  const globalRoot = configured ? null : await npmGlobalRoot()
  if (globalRoot !== null && !isAbsolute(globalRoot))
    throw new Error('npm 未返回有效的全局安装目录')
  const root = configured || join(globalRoot, PI_PACKAGE)
  if (!existsSync(root)) return null
  const packageRoot = realpathSync(root)
  const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
  if (manifest.name !== PI_PACKAGE || typeof manifest.version !== 'string')
    throw new Error(`全局 Pi 包清单无效：${packageRoot}`)
  const requirePi = createRequire(join(packageRoot, 'package.json'))
  const semver = requirePi('semver')
  if (!semver.gte(manifest.version, INSTALL_VERSION))
    throw new Error(`全局 Pi ${manifest.version} 过旧，需要 ${INSTALL_VERSION} 或更高的兼容版本`)
  const packages = new Map([[PI_PACKAGE, { root: packageRoot, manifest }]])
  for (const name of CORE_PACKAGES.slice(1)) {
    const directory = requirePi.resolve
      .paths(name)
      .map((parent) => join(parent, name))
      .find((candidate) => existsSync(join(candidate, 'package.json')))
    if (!directory) throw new Error(`全局 Pi 缺少核心依赖：${name}`)
    const dependency = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
    const range = manifest.dependencies?.[name]
    if (!range || !semver.satisfies(dependency.version, range))
      throw new Error(
        `全局 Pi 核心依赖不一致：${name}@${dependency.version}，需要 ${range || '有效依赖声明'}`
      )
    packages.set(name, { root: realpathSync(directory), manifest: dependency })
  }
  // 新版 SDK 的内部 Pi 模块也必须由同一依赖树提供，不能落回宿主依赖。
  for (const owner of packages.values()) {
    for (const name of Object.keys(owner.manifest.dependencies ?? {})) {
      if (!name.startsWith('@earendil-works/') || packages.has(name)) continue
      const requireOwner = createRequire(join(owner.root, 'package.json'))
      const directory = requireOwner.resolve
        .paths(name)
        .map((parent) => join(parent, name))
        .find((candidate) => existsSync(join(candidate, 'package.json')))
      if (!directory) throw new Error(`全局 Pi 缺少内部依赖：${name}`)
      packages.set(name, {
        root: realpathSync(directory),
        manifest: JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
      })
    }
  }
  const schemaRoot = requirePi.resolve
    .paths('typebox')
    .map((parent) => join(parent, 'typebox'))
    .find((candidate) => existsSync(join(candidate, 'package.json')))
  if (!schemaRoot) throw new Error('全局 Pi 缺少 typebox')
  packages.set('typebox', {
    root: realpathSync(schemaRoot),
    manifest: JSON.parse(readFileSync(join(schemaRoot, 'package.json'), 'utf8'))
  })
  const cli = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.pi
  if (!cli || !existsSync(join(packageRoot, cli)))
    throw new Error(`全局 Pi 命令入口缺失：${packageRoot}`)
  return { root: packageRoot, version: manifest.version, packages }
}

function resolvePiImport(runtime, specifier) {
  const name = [...runtime.packages.keys()].find(
    (value) => specifier === value || specifier.startsWith(`${value}/`)
  )
  if (!name) {
    // Next 外部模块会先变成绝对路径；只重定向已选核心包的 JS 文件。
    const path = specifier.startsWith('file:') ? fileURLToPath(specifier) : specifier
    if (!isAbsolute(path) || !/\.[cm]?js$/u.test(path)) return null
    const normalized = path.replaceAll('\\', '/')
    for (const [packageName, selected] of runtime.packages) {
      const prefix = `/node_modules/${packageName}/`
      const position = normalized.lastIndexOf(prefix)
      if (position !== -1) {
        const local = normalized.slice(position + prefix.length)
        if (!local.includes('node_modules/')) return pathToFileURL(join(selected.root, local)).href
      }
    }
    return null
  }
  const { root, manifest } = runtime.packages.get(name)
  const key = specifier === name ? '.' : `.${specifier.slice(name.length)}`
  let target = manifest.exports?.[key]
  if (!manifest.exports) target = key === '.' ? manifest.main : key
  if (!target) {
    const pattern = Object.keys(manifest.exports ?? {}).find(
      (value) => value.endsWith('*') && key.startsWith(value.slice(0, -1))
    )
    if (pattern) {
      target = manifest.exports[pattern]
      if (typeof target === 'object') target = target.import ?? target.default
      target = target.replace('*', key.slice(pattern.length - 1))
    }
  }
  if (typeof target === 'object' && target) target = target.import ?? target.default
  if (typeof target !== 'string') throw new Error(`全局 Pi 不支持所需模块：${specifier}`)
  return pathToFileURL(join(root, target)).href
}

async function checkPiModules(runtime) {
  const sdk = await import(resolvePiImport(runtime, PI_PACKAGE))
  const required = [
    'DefaultPackageManager',
    'DefaultResourceLoader',
    'ModelRuntime',
    'SessionManager',
    'SettingsManager',
    'createAgentSession',
    'createAgentSessionFromServices',
    'createCodingTools',
    'createEventBus',
    'createExtensionRuntime',
    'createReadOnlyTools',
    'defineTool',
    'getAgentDir',
    'getDocsPath',
    'loadProjectContextFiles',
    'loadSkillsFromDir',
    'migrateSessionEntries',
    'parseSessionEntries',
    'resolveModelScopeWithDiagnostics',
    'stripFrontmatter',
    'truncateHead'
  ]
  const missing = required.filter((name) => typeof sdk[name] !== 'function')
  if (missing.length)
    throw new Error(
      `全局 Pi ${runtime.version} 与 Pi Desk 不兼容，缺少 SDK 能力：${missing.join('、')}`
    )
}

function formatPiRuntimeError(error) {
  const reason = error instanceof Error ? error.message : String(error)
  const command = `npm install -g --ignore-scripts ${PI_PACKAGE}@${INSTALL_VERSION}`
  return [
    reason,
    '',
    'Pi Desk 使用当前 Node/npm 环境中的全局 Pi，不会自动安装或更新 Pi。',
    `如需安装、更新或修复 Pi，以下命令任选一条，安装当前 Pi Desk 使用的 Pi ${INSTALL_VERSION}：`,
    '',
    '官方 npm 源：',
    `  ${command} --registry=https://registry.npmjs.org`,
    '',
    '国内镜像（腾讯云，供中国用户加速下载）：',
    `  ${command} --registry=https://mirrors.cloud.tencent.com/npm`,
    '镜像同步可能有延迟；找不到版本时，改用官方源。',
    '',
    '安装后运行 pi --version 确认版本，再重新执行原来的 Pi Desk 启动命令。',
    '若仍提示旧版本，请确认安装 Pi 和启动 Pi Desk 使用的是同一个 Node/npm 环境。',
    '桌面端也可在安装选项中选择下载源，确认安装后点击“重新检测”并启动。',
    '安装与更新说明：https://pidesk.dev/docs/installation/'
  ].join('\n')
}

async function checkGlobalPi() {
  const runtime = await findGlobalPi()
  if (runtime) await checkPiModules(runtime)
  return {
    status: runtime ? 'ready' : 'missing',
    version: runtime?.version ?? null,
    path: runtime?.root ?? null,
    installVersion: INSTALL_VERSION
  }
}

module.exports = {
  PI_RUNTIME_EXIT_CODE,
  findGlobalPi,
  resolvePiImport,
  checkPiModules,
  checkGlobalPi,
  formatPiRuntimeError
}
