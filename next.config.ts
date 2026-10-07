import { execFileSync } from 'node:child_process'
import type { NextConfig } from 'next'
import packageJson from './package.json'

function resolveVersionUpdatedAt(): string {
  const publishedAt = process.env.PI_DESK_RELEASE_PUBLISHED_AT?.trim()
  if (publishedAt) return publishedAt

  try {
    return execFileSync('git', ['log', '-1', '--format=%cI', '--', 'package.json'], {
      cwd: __dirname,
      encoding: 'utf8',
      timeout: 3_000,
      windowsHide: true
    }).trim()
  } catch {
    return ''
  }
}

const nextConfig: NextConfig = {
  agentRules: false,
  experimental: {
    turbopackPluginRuntimeStrategy: 'workerThreads'
  },
  env: {
    PI_DESK_APP_VERSION: packageJson.version,
    PI_DESK_VERSION_UPDATED_AT: resolveVersionUpdatedAt()
  },
  outputFileTracingRoot: __dirname,
  transpilePackages: ['@jetcrab/pi-desk-sdk'],
  // Next 的 chunk 防扩散规则匹配 .next/server/chunks，生产目录需保留 .next 末级名。
  distDir:
    process.env.PI_DESK_E2E === '1'
      ? (process.env.PI_DESK_E2E_NEXT_DIR ?? 'temp/e2e/next')
      : process.env.NODE_ENV === 'development'
        ? 'temp/next-dev'
        : 'temp/build/pi-desk/release/.next',
  serverExternalPackages: [
    '@earendil-works/pi-coding-agent',
    '@earendil-works/pi-agent-core',
    '@earendil-works/pi-ai',
    '@earendil-works/pi-tui',
    'jiti',
    'typebox',
    'node-pty',
    '@xterm/headless',
    '@xterm/addon-serialize'
  ]
}

export default nextConfig
