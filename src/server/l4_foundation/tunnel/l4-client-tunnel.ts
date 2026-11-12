import 'server-only'

import { execFile } from 'node:child_process'
import { isAbsolute } from 'node:path'
import { promisify } from 'node:util'
import {
  L4TunnelPublicationSchema,
  type L4TunnelPublication
} from '@common/l4_foundation/tunnel/l4-client-tunnel-contract'

const execute = promisify(execFile)

export async function resolveL4ClientTunnel(
  remotePort: number,
  signal: AbortSignal
): Promise<L4TunnelPublication> {
  const executable = process.env.PI_DESK_DESKTOP_EXECUTABLE
  const configPath = process.env.PI_DESK_DESKTOP_CONFIG
  if (!executable || !configPath || !isAbsolute(executable) || !isAbsolute(configPath)) {
    throw new Error('后端未由桌面托管，无法查询端口的隧道发布')
  }
  try {
    const { stdout } = await execute(
      executable,
      ['--tunnel-resolve', '--port', String(remotePort)],
      {
        env: { ...process.env, PI_DESK_DESKTOP_CONFIG: configPath },
        windowsHide: true,
        timeout: 5_000,
        maxBuffer: 16 * 1024,
        encoding: 'utf8',
        signal
      }
    )
    const target = L4TunnelPublicationSchema.parse(JSON.parse(stdout))
    if (target.remotePort !== remotePort) throw new Error('发布信息与请求端口不一致')
    return target
  } catch (cause) {
    if (signal.aborted) throw new Error('端口发布查询已取消')
    console.warn('[Pi Desk][ClientTunnel] 查询端口发布失败', {
      remotePort,
      message: cause instanceof Error ? cause.message : String(cause)
    })
    throw new Error(`后端端口 ${remotePort} 没有可用的隧道发布，请检查桌面及发布状态`)
  }
}
