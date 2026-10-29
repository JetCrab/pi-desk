import 'server-only'

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { getL4HostSettingsStore } from '@server/l4_foundation/l4-host-settings-store'

type Command = Parameters<ExtensionAPI['registerCommand']>[1]

export function withL4PiMcpLogoutConfirmation(command: Command): Command {
  return {
    ...command,
    async handler(args, context): Promise<void> {
      const [action, name, ...extra] = args.trim().split(/\s+/)
      if (action !== 'logout' || extra.length > 0) {
        await command.handler(args, context)
        return
      }

      const chinese = getL4HostSettingsStore().getSnapshot().region.locale === 'zh-CN'
      let target: string | undefined = name
      if (!target) {
        // 候选来自当前内置命令，不从配置重建连接或解析状态通知。
        const candidates = await command.getArgumentCompletions?.('logout ')
        const names = (candidates ?? []).map((item) => item.value.slice('logout '.length))
        if (names.length === 0) {
          context.ui.notify(
            chinese ? '当前没有可退出登录的 MCP 服务。' : 'No MCP server is available to sign out.',
            'info'
          )
          return
        }
        target =
          names.length === 1
            ? names[0]
            : await context.ui.select(chinese ? '选择 MCP 服务' : 'Select MCP server', names)
      }
      if (!target) return
      const confirmed = await context.ui.confirm(
        chinese ? `退出登录：${target}` : `Sign out: ${target}`,
        chinese
          ? '将删除此服务的共享登录凭据，其他会话下次访问也可能需要重新登录。'
          : 'This deletes the server’s shared credentials. Other sessions may need to sign in again.'
      )
      if (!confirmed) return
      console.info('[Pi Desk][MCP] 用户确认退出登录', { server: target })
      await command.handler(`logout ${target}`, context)
    }
  }
}
