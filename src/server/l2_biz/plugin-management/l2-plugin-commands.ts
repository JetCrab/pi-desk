import 'server-only'

import { getAgentDir } from '@earendil-works/pi-coding-agent'
import { selectL4LocalizedText } from '@common/l4_foundation/locale/l4-localized-text'
import type { L2PluginManagementItem } from '@common/l2_biz/plugin/l2-plugin-management-contract'
import type {
  L4PiDeskCommandContext,
  L4PiDeskCommandResult,
  L4PiDeskPluginCommand
} from '@server/l4_foundation/pidesk/l4-pidesk-runtime'
import { isL4PiDeskSafeMode } from '@server/l4_foundation/pi/l4-pi-desk-mode'
import { getL2PluginManagement, type L2PluginManagement } from './l2-plugin-management'
import {
  findL2PluginCommandTarget,
  readL2PluginCommandName,
  readL2PluginNpmName,
  resolveL2LocalPluginCommandTarget
} from './l2-plugin-command-target'

type CommandManagement = Pick<
  L2PluginManagement,
  'list' | 'get' | 'apply' | 'reinstall' | 'del' | 'waitForOperations'
>

function summary(
  item: L2PluginManagementItem,
  agentDir: string
): Pick<L2PluginManagementItem, 'source' | 'kind' | 'version' | 'status'> & {
  name: string
  operation?: NonNullable<L2PluginManagementItem['operation']>
  error?: NonNullable<L2PluginManagementItem['error']>
} {
  return {
    name: readL2PluginCommandName(item, agentDir),
    source: item.source,
    kind: item.kind,
    version: item.version,
    status: item.status,
    ...(item.operation ? { operation: item.operation } : {}),
    ...(item.error ? { error: item.error } : {})
  }
}

function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function notifyOutcome(
  execution: Promise<void>,
  context: L4PiDeskCommandContext,
  description: string,
  result: () => Promise<string>
): Promise<void> {
  let message: string
  try {
    await execution
    context.signal.throwIfAborted()
    message = `结果：${await result()}`
  } catch (error) {
    if (context.signal.aborted) return
    message = `结果：失败或尚未完成。\n原因：${failureMessage(error)}`
  }
  try {
    await context.notify(`Pi Desk 命令执行结果\n\n操作：${description}\n范围：全局\n${message}`)
  } catch (error) {
    console.warn('[Pi Desk][Commands] 异步结果投递失败', {
      operation: description,
      message: failureMessage(error)
    })
  }
}

export async function executeL2PluginCommand(
  command: L4PiDeskPluginCommand,
  context: L4PiDeskCommandContext,
  management: CommandManagement = getL2PluginManagement(),
  agentDir = getAgentDir()
): Promise<L4PiDeskCommandResult> {
  context.signal.throwIfAborted()
  if (isL4PiDeskSafeMode()) throw new Error('基础模式不执行插件管理，请正常启动 Pi Desk 后操作')
  const snapshot = await management.list()
  if (command.action === 'list') {
    return {
      mode: 'sync',
      message: JSON.stringify({
        plugins: snapshot.plugins.map((item) => summary(item, agentDir)),
        restartRequired: snapshot.restartRequired,
        ...(snapshot.loadError ? { loadError: snapshot.loadError } : {})
      })
    }
  }
  const name = command.name
  if (!name) throw new Error('缺少插件名字')
  const existing = findL2PluginCommandTarget(snapshot.plugins, name, agentDir)
  if (command.action === 'show') {
    if (!existing) throw new Error(`插件不存在：${name}`)
    const detail = await management.get(existing.source)
    return {
      mode: 'sync',
      message: JSON.stringify({
        ...summary(existing, agentDir),
        detail: { tools: detail.tools, skills: detail.skills, prompts: detail.prompts }
      })
    }
  }
  context.signal.throwIfAborted()
  let sources: string[]
  if (command.action === 'remove') {
    if (!existing) throw new Error(`插件不存在：${name}`)
    if (existing.kind !== 'package')
      throw new Error('当前插件管理只支持卸载包来源，不支持卸载裸扩展')
    await management.del(existing.source)
    sources = [existing.source]
  } else {
    const local = await resolveL2LocalPluginCommandTarget(name, agentDir, existing)
    const npmName = existing ? readL2PluginNpmName(existing.source) : null
    if (local && npmName) throw new Error(`同时存在本地扩展和 npm 来源，请先处理同名冲突：${name}`)
    if (local) {
      if (command.version) throw new Error('本地插件加载当前代码，不支持通过版本号切换源码')
      const source = existing?.source ?? local
      await management.apply([source])
      sources = [source]
    } else {
      if (existing && !npmName)
        throw new Error('该来源不能通过名字重新安装；本地插件必须位于全局 extensions 目录')
      const source = `npm:${npmName ?? name}${command.version ? `@${command.version}` : ''}`
      await management.reinstall(source, existing?.source)
      sources = [...new Set([source, ...(existing ? [existing.source] : [])])]
    }
  }
  const action = command.action === 'remove' ? '卸载' : '安装'
  const description = `${action} ${name}${command.version ? `@${command.version}` : ''}`
  console.info('[Pi Desk][Commands] 插件命令已接纳', { operation: description, sources })
  void notifyOutcome(
    management.waitForOperations(sources, context.signal),
    context,
    description,
    async () => {
      const current = await management.list()
      const target = findL2PluginCommandTarget(current.plugins, name, agentDir)
      if (command.action === 'remove') {
        if (target) throw new Error('卸载后仍发现该包来源，无法确认卸载完成')
        return '已卸载外层能力；已有会话保留原扩展，手动重载 PI 后移除。'
      }
      if (!target) throw new Error('未发现安装后的插件，无法确认生效')
      if (target.error) throw new Error(selectL4LocalizedText(target.error.message, 'zh-CN'))
      if (target.status === 'disabled') throw new Error('该插件仍被现有配置禁用，尚未生效')
      if (command.version && target.version !== command.version)
        throw new Error(`实际版本 ${target.version ?? '未知'} 与目标版本 ${command.version} 不一致`)
      return `已安装${target.version ? ` ${target.version}` : ''}，外层已更新。已有会话扩展不变，新会话或手动重载 PI 后使用新版。`
    }
  )
  return {
    mode: 'async',
    message: `本次${action}已被接纳：${name}。执行结果会插入本会话并唤醒模型；无独立工作时结束当前轮，无需持续查询。`
  }
}
