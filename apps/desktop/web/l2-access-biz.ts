import {
  desktopCommand,
  getControlState,
  getTargetSettings,
  getTunnelConnection
} from './l4-desktop-ipc'
import { runDesktopAction } from './l2-desktop-biz'

export type AccessDraft = {
  controlServerUrl: string
  controlKey: string
  publicPort: string
}

export async function readAccessSettings(url: string): Promise<AccessDraft> {
  const [settings, connection] = await Promise.all([getTargetSettings(url), getTunnelConnection()])
  if (!settings.target) throw new Error('这个地址已被移除，请返回后重试')
  return {
    ...connection,
    publicPort: settings.target.tunnel ? String(settings.target.tunnel.publicPort) : ''
  }
}

export async function saveAndStartAccess(url: string, draft: AccessDraft): Promise<void> {
  const address = new URL(draft.controlServerUrl.trim())
  if (!['http:', 'https:'].includes(address.protocol) || address.username || address.password) {
    throw new Error('请输入有效的中转服务网址')
  }
  const publicPort = Number(draft.publicPort)
  if (!draft.controlKey.trim()) throw new Error('请输入连接密钥')
  if (!Number.isInteger(publicPort) || publicPort < 1 || publicPort > 65535)
    throw new Error('访问端口应为 1 到 65535 的整数')
  const settings = await getTargetSettings(url)
  if (!settings.target) throw new Error('这个地址已被移除，请返回后重试')
  if (settings.target.tunnel) {
    await runDesktopAction('stop-tunnel', url)
    const deadline = Date.now() + 10_000
    // 关闭命令只请求停止，必须等待旧连接释放后才能按新设置连接。
    while (true) {
      const state = await getControlState()
      const tunnel = state.targets.find((target) => target.url === url)?.tunnel
      if (!tunnel || tunnel.status === 'stopped' || tunnel.status === 'failed') break
      if (Date.now() >= deadline) throw new Error('旧连接尚未关闭，请稍后重试')
      await new Promise<void>((resolve) => window.setTimeout(resolve, 100))
    }
  }
  await desktopCommand('apply_target_command', {
    originalUrl: url,
    value: { ...settings.target, tunnel: { enabled: false, publicPort } }
  })
  await desktopCommand('apply_tunnel_connection_command', {
    value: { controlServerUrl: address.href, controlKey: draft.controlKey.trim() }
  })
  try {
    await runDesktopAction('start-tunnel', url)
  } catch (cause) {
    throw new Error(
      `设置已保存，但未能开启访问：${cause instanceof Error ? cause.message : String(cause)}`
    )
  }
}
