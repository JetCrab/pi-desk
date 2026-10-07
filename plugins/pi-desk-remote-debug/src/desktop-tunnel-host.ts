import { execFile } from 'node:child_process'
import { isAbsolute } from 'node:path'
import { promisify } from 'node:util'
import { z } from 'zod'

const execute = promisify(execFile)
const tunnelInfoSchema = z.object({ controlServerUrl: z.string().nullable() })

export function resolveDesktopTunnelHost(
  env: NodeJS.ProcessEnv = process.env
): { executable: string; configPath: string } | null {
  const executable = env.PI_DESK_DESKTOP_EXECUTABLE?.trim()
  const configPath = env.PI_DESK_DESKTOP_CONFIG?.trim()
  if (!executable && !configPath) return null
  if (!executable || !configPath) {
    throw new Error('桌面隧道能力需要同时提供 PI_DESK_DESKTOP_EXECUTABLE 和 PI_DESK_DESKTOP_CONFIG')
  }
  if (!isAbsolute(executable) || !isAbsolute(configPath)) {
    throw new Error('桌面隧道程序与配置路径必须是绝对路径')
  }
  return { executable, configPath }
}

export async function readDesktopTunnelServer(): Promise<string | null> {
  const host = resolveDesktopTunnelHost()
  if (!host) return null
  const { stdout } = await execute(host.executable, ['--tunnel-info'], {
    env: { ...process.env, PI_DESK_DESKTOP_CONFIG: host.configPath },
    windowsHide: true,
    timeout: 5000,
    maxBuffer: 16 * 1024,
    encoding: 'utf8'
  })
  return tunnelInfoSchema.parse(JSON.parse(stdout)).controlServerUrl
}
