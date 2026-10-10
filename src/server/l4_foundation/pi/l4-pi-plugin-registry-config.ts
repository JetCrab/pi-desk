import 'server-only'

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { promisify } from 'node:util'
import { getAgentDir } from '@earendil-works/pi-coding-agent'

const execute = promisify(execFile)
type NpmConfig = Record<string, string>
let cached: { cwd: string; prefix: string; expires: number; value: Promise<NpmConfig> } | undefined

function npmCli(): string | undefined {
  const directories = [
    dirname(process.execPath),
    ...(process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':')
  ]
  for (const directory of directories) {
    for (const path of [
      join(directory, 'node_modules/npm/bin/npm-cli.js'),
      resolve(directory, '../lib/node_modules/npm/bin/npm-cli.js')
    ]) {
      if (existsSync(path)) return path
    }
  }
  return undefined
}

function expand(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (original, name: string) => process.env[name] ?? original)
}

async function readNpmrc(path: string, config: NpmConfig): Promise<void> {
  let text: string
  try {
    const file = await readFile(path)
    if (file.length > 256 * 1024) throw new Error('npm 配置文件过大')
    text = file.toString('utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([^;#][^=]*?)\s*=\s*(.*?)\s*$/.exec(line)
    if (!match) continue
    const value = match[2]!.replace(/\s+[;#].*$/, '').replace(/^(['"])(.*)\1$/, '$2')
    config[match[1]!.trim()] = expand(value)
  }
}

function npmConfigPath(path: string, cwd: string): string {
  const homePattern = process.platform === 'win32' ? /^~[\\/]/ : /^~\//
  return homePattern.test(path) ? resolve(homedir(), path.slice(2)) : resolve(cwd, path)
}

async function loadConfig(cwd: string, installRoot: string): Promise<NpmConfig> {
  const environment: NpmConfig = {}
  // 与 npm loadEnv 一致：大小写统一后按环境枚举顺序覆盖，空值不参与配置。
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && value !== '' && /^npm_config_/i.test(key)) {
      const original = key.slice(11)
      const name = original.startsWith('//')
        ? original
        : original.replace(/(?!^)_/g, '-').toLowerCase()
      environment[name] = expand(value)
    }
  }
  const cli = npmCli()
  let effective: Record<string, unknown> = {}
  if (cli) {
    try {
      await mkdir(cwd, { recursive: true })
      const result = await execute(
        process.execPath,
        [cli, 'config', 'list', '--json', '--prefix', installRoot],
        { cwd, timeout: 4000, maxBuffer: 512 * 1024, windowsHide: true }
      )
      effective = JSON.parse(result.stdout) as Record<string, unknown>
    } catch {
      // 不输出 npm 的 stderr：其中可能包含注册表鉴权信息。
      console.warn('[Pi Desk][PluginRegistry] npm 有效配置读取失败，改用 npmrc 和环境配置')
    }
  }
  const config: NpmConfig = {}
  if (cli) await readNpmrc(resolve(dirname(cli), '../npmrc'), config)
  // npm 默认 globalconfig 同样受 CLI --prefix 影响，不能回退到 Node 安装目录。
  const globalPath =
    typeof effective.globalconfig === 'string'
      ? effective.globalconfig
      : (environment.globalconfig ?? join(installRoot, 'etc/npmrc'))
  const userPath =
    typeof effective.userconfig === 'string'
      ? effective.userconfig
      : (environment.userconfig ?? join(homedir(), '.npmrc'))
  await readNpmrc(npmConfigPath(globalPath, cwd), config)
  await readNpmrc(npmConfigPath(userPath, cwd), config)
  // Pi user-scope 安装传入 --prefix，项目 npmrc 属于安装根，不属于应用或维护 cwd。
  if (
    effective.global !== true &&
    environment.global !== 'true' &&
    effective.location !== 'global' &&
    environment.location !== 'global'
  )
    await readNpmrc(join(installRoot, '.npmrc'), config)
  for (const [key, value] of Object.entries(effective)) {
    if (
      typeof value === 'string' &&
      value !== '(protected)' &&
      !/auth|password|username/i.test(key)
    )
      config[key] = value
  }
  return { ...config, ...environment }
}

export function readRegistryNpmConfig(agentDir = getAgentDir()): Promise<NpmConfig> {
  const cwd =
    process.env.PI_DESK_PACKAGE_MAINTENANCE_CWD ??
    join(agentDir, 'pi-desk', 'plugin-package-manager')
  const prefix = join(agentDir, 'npm')
  if (!cached || cached.cwd !== cwd || cached.prefix !== prefix || cached.expires <= Date.now()) {
    const value = loadConfig(cwd, prefix)
    cached = { cwd, prefix, expires: Date.now() + 30_000, value }
    void value.catch(() => {
      if (cached?.value === value) cached = undefined
    })
  }
  return cached.value
}

export function registryAuth(url: URL, config: NpmConfig): string | undefined {
  const target = `//${url.host}${url.pathname}`
  const prefixes = Object.keys(config)
    .flatMap((key) => {
      const match = /^(\/\/.*\/):(?:_authToken|_auth|username|_password)$/i.exec(key)
      return match && target.startsWith(match[1]!) ? [match[1]!] : []
    })
    .sort((a, b) => b.length - a.length)
  for (const prefix of prefixes) {
    const token = config[`${prefix}:_authToken`] ?? config[`${prefix}:_authtoken`]
    if (token && !token.includes('${')) return `Bearer ${token}`
    const auth = config[`${prefix}:_auth`]
    if (auth && !auth.includes('${')) return `Basic ${auth}`
    const username = config[`${prefix}:username`]
    const password = config[`${prefix}:_password`]
    if (username && password && !password.includes('${'))
      return `Basic ${Buffer.from(`${username}:${Buffer.from(password, 'base64').toString('utf8')}`).toString('base64')}`
  }
  // npm 的旧式非限定鉴权仅用于配置中的默认 registry。
  const registry = config.registry
  if (registry) {
    const base = new URL(registry)
    if (
      url.origin === base.origin &&
      url.pathname.startsWith(`${base.pathname.replace(/\/+$/, '')}/`)
    ) {
      const token = config._authToken ?? config._authtoken
      if (token && !token.includes('${')) return `Bearer ${token}`
      if (config._auth && !config._auth.includes('${')) return `Basic ${config._auth}`
    }
  }
  return undefined
}
