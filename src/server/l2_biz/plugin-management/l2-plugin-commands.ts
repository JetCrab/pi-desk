import 'server-only'

import { getAgentDir } from '@earendil-works/pi-coding-agent'
import { selectL4LocalizedText } from '@common/l4_foundation/locale/l4-localized-text'
import type {
  L2PluginManagementItem,
  L2PluginManagementSnapshot
} from '@common/l2_biz/plugin/l2-plugin-management-contract'
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
  'list' | 'get' | 'apply' | 'reinstall' | 'del' | 'batch' | 'waitForOperations'
>

interface CommandTarget {
  name: string
  source: string
  previousSource?: string
  local: boolean
}

interface CommandAcceptance {
  target: CommandTarget
  error: string | null
}

function summary(item: L2PluginManagementItem, agentDir: string): object {
  return {
    name: readL2PluginCommandName(item, agentDir),
    source: item.source,
    kind: item.kind,
    version: item.version,
    status: item.status,
    ...(item.updateTag === undefined ? {} : { updateTag: item.updateTag }),
    ...(item.availableVersion === undefined ? {} : { availableVersion: item.availableVersion }),
    ...(item.updateError === undefined ? {} : { updateError: item.updateError }),
    ...(item.operation ? { operation: item.operation } : {}),
    ...(item.error ? { error: item.error } : {})
  }
}

function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function resolveTargets(
  command: L4PiDeskPluginCommand,
  names: readonly string[],
  snapshot: L2PluginManagementSnapshot,
  agentDir: string
): Promise<CommandTarget[]> {
  const targets = new Map<string, CommandTarget>()
  for (const name of names) {
    const existing = findL2PluginCommandTarget(snapshot.plugins, name, agentDir)
    if (command.action === 'reload') {
      if (!existing) throw new Error(`插件不存在：${name}`)
      if (existing.status === 'disabled') throw new Error(`插件已禁用，请先启用：${name}`)
      targets.set(existing.source, { name, source: existing.source, local: false })
      continue
    }
    if (command.action === 'remove') {
      if (!existing) throw new Error(`插件不存在：${name}`)
      if (existing.kind !== 'package') {
        throw new Error(`当前插件管理只支持卸载包来源，不支持卸载裸扩展：${name}`)
      }
      targets.set(existing.source, { name, source: existing.source, local: false })
      continue
    }
    const local = await resolveL2LocalPluginCommandTarget(name, agentDir, existing)
    const npmName = existing ? readL2PluginNpmName(existing.source) : null
    if (local && npmName) throw new Error(`同时存在本地扩展和 npm 来源，请先处理同名冲突：${name}`)
    if (local) {
      if (command.version || command.tag) {
        throw new Error(`本地插件加载当前代码，不支持通过版本号或渠道切换源码：${name}`)
      }
      targets.set(local, { name, source: existing?.source ?? local, local: true })
    } else {
      if (existing && !npmName) {
        throw new Error(`该来源不能通过名字重新安装；本地插件必须位于全局 extensions 目录：${name}`)
      }
      const source = `npm:${npmName ?? name}${command.version ? `@${command.version}` : ''}`
      targets.set(`npm:${npmName ?? name}`, {
        name,
        source,
        ...(existing ? { previousSource: existing.source } : {}),
        local: false
      })
    }
  }
  return [...targets.values()]
}

async function acceptTargets(
  command: L4PiDeskPluginCommand,
  targets: CommandTarget[],
  management: CommandManagement
): Promise<CommandAcceptance[]> {
  if (command.action === 'reload') {
    const acceptances: CommandAcceptance[] = []
    for (const target of targets) {
      try {
        await management.apply([target.source])
        acceptances.push({ target, error: null })
      } catch (error) {
        acceptances.push({ target, error: failureMessage(error) })
      }
    }
    return acceptances
  }
  const results = new Map<string, string | null>()
  const packages = targets.filter((target) => !target.local)
  const locals = targets.filter((target) => target.local)
  if (packages.length > 0) {
    try {
      if (command.names) {
        const response = await management.batch(
          command.action === 'remove'
            ? { action: 'del', sources: packages.map((target) => target.source) }
            : {
                action: 'add',
                items: packages.map((target) => ({
                  source: target.source,
                  ...(command.tag ? { tag: command.tag } : {})
                }))
              }
        )
        for (const result of response.results) results.set(result.source, result.error)
      } else {
        const target = packages[0]!
        if (command.action === 'remove') {
          await management.del(target.source)
        } else if (command.tag) {
          await management.reinstall(target.source, target.previousSource, { tag: command.tag })
        } else {
          await management.reinstall(target.source, target.previousSource)
        }
        results.set(target.source, null)
      }
    } catch (error) {
      for (const target of packages) results.set(target.source, failureMessage(error))
    }
  }
  if (locals.length > 0) {
    try {
      await management.apply(locals.map((target) => target.source))
      for (const target of locals) results.set(target.source, null)
    } catch (error) {
      for (const target of locals) results.set(target.source, failureMessage(error))
    }
  }
  return targets.map((target) => ({
    target,
    error: results.has(target.source) ? results.get(target.source)! : '业务未返回该来源的接纳结果'
  }))
}

function completedResult(
  command: L4PiDeskPluginCommand,
  target: CommandTarget,
  snapshot: L2PluginManagementSnapshot,
  agentDir: string
): string {
  const item = findL2PluginCommandTarget(
    snapshot.plugins,
    readL2PluginNpmName(target.source) ?? target.name,
    agentDir
  )
  if (command.action === 'remove') {
    if (item) throw new Error('卸载后仍发现该包来源，无法确认卸载完成')
    return '成功：已卸载并完成宿主插件应用'
  }
  if (!item) throw new Error('未发现安装后的插件，无法确认生效')
  if (item.error) throw new Error(selectL4LocalizedText(item.error.message, 'zh-CN'))
  if (item.status === 'disabled') throw new Error('该插件仍被现有配置禁用，尚未生效')
  if (command.version && item.version !== command.version) {
    throw new Error(`实际版本 ${item.version ?? '未知'} 与目标版本 ${command.version} 不一致`)
  }
  if (command.action === 'reload') return '成功：已重新加载本机代码，已有 Pi 会话保持不变'
  return target.local
    ? '成功：已加载当前代码，服务与界面已更新'
    : `成功：已安装${item.version ? ` ${item.version}` : ''}并完成宿主加载`
}

async function collectOutcomes(
  command: L4PiDeskPluginCommand,
  acceptances: CommandAcceptance[],
  management: CommandManagement,
  context: L4PiDeskCommandContext,
  agentDir: string
): Promise<string[]> {
  // 每个目标独立等待，失败或等待重启不能提前结束其他目标的观察。
  const errors = await Promise.all(
    acceptances.map(async ({ target, error }): Promise<string | null> => {
      if (error !== null) return error
      try {
        await management.waitForOperations(
          [...new Set([target.source, ...(target.previousSource ? [target.previousSource] : [])])],
          context.signal
        )
        return null
      } catch (error) {
        return failureMessage(error)
      }
    })
  )
  context.signal.throwIfAborted()
  let current: L2PluginManagementSnapshot
  try {
    current = await management.list()
  } catch (error) {
    return acceptances.map(
      ({ target, error: acceptanceError }, index) =>
        `${target.name}：${acceptanceError !== null ? '未接纳' : '失败或尚未完成'}：${errors[index] ?? failureMessage(error)}`
    )
  }
  return acceptances.map(({ target, error: acceptanceError }, index) => {
    const error = errors[index]
    if (acceptanceError !== null) return `${target.name}：未接纳：${acceptanceError}`
    if (error !== null) {
      const waitingForRestart =
        (current.restartRequired &&
          current.plugins.some(
            (item) =>
              [target.source, target.previousSource].includes(item.source) &&
              item.operation?.phase === 'waiting'
          )) ||
        /^插件尚未生效.*重启/.test(error)
      return `${target.name}：${waitingForRestart ? '等待重启，尚未生效' : '失败或尚未完成'}：${error}`
    }
    try {
      return `${target.name}：${completedResult(command, target, current, agentDir)}`
    } catch (error) {
      return `${target.name}：失败或尚未完成：${failureMessage(error)}`
    }
  })
}

async function notifyOutcome(
  execution: Promise<string[]>,
  context: L4PiDeskCommandContext,
  description: string
): Promise<void> {
  let message: string
  try {
    const results = await execution
    context.signal.throwIfAborted()
    message = `结果：\n${results.join('\n')}\n\n以上为宿主插件应用结果；已有 Pi 会话的工具变更需新建会话或主动 reload 才生效。`
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
  const snapshot = await management.list(
    command.action === 'list'
      ? {
          ...(command.checkUpdates ? { checkUpdates: true } : {}),
          ...(command.tag ? { tag: command.tag } : {})
        }
      : false
  )
  if (command.action === 'list') {
    return {
      mode: 'sync',
      message: JSON.stringify({
        plugins: snapshot.plugins
          .filter((item) => !command.tag || item.updateTag === command.tag)
          .map((item) => summary(item, agentDir)),
        restartRequired: snapshot.restartRequired,
        ...(snapshot.loadError ? { loadError: snapshot.loadError } : {})
      })
    }
  }
  const names = command.names ?? (command.name ? [command.name] : [])
  if (names.length === 0) throw new Error('缺少插件名字')
  if (command.action === 'show') {
    if (names.length !== 1) throw new Error('show 只支持单个插件名字')
    const existing = findL2PluginCommandTarget(snapshot.plugins, names[0]!, agentDir)
    if (!existing) throw new Error(`插件不存在：${names[0]}`)
    const detail = await management.get(existing.source)
    return {
      mode: 'sync',
      message: JSON.stringify({
        ...summary(existing, agentDir),
        detail: { tools: detail.tools, skills: detail.skills, prompts: detail.prompts }
      })
    }
  }
  const targets = await resolveTargets(command, names, snapshot, agentDir)
  context.signal.throwIfAborted()
  const acceptances = await acceptTargets(command, targets, management)
  const acceptedCount = acceptances.filter((result) => result.error === null).length
  if (acceptedCount === 0) {
    throw new Error(acceptances.map(({ target, error }) => `${target.name}：${error}`).join('\n'))
  }
  const action =
    command.action === 'remove' ? '卸载' : command.action === 'reload' ? '重载' : '安装'
  const description = `${action} ${targets.map((target) => target.name).join('、')}${command.version ? `@${command.version}` : command.tag ? `（渠道 ${command.tag}）` : ''}`
  console.info('[Pi Desk][Commands] 插件命令已接纳', {
    operation: description,
    sources: targets.map((target) => target.source),
    acceptedCount,
    rejectedCount: acceptances.length - acceptedCount
  })
  void notifyOutcome(
    collectOutcomes(command, acceptances, management, context, agentDir),
    context,
    description
  )
  return {
    mode: 'async',
    message: `本次${action}已被接纳（${acceptedCount}/${targets.length} 项）：${targets.map((target) => target.name).join('、')}${acceptedCount < targets.length ? '；其余项未接纳' : ''}。执行结果会统一插入本会话并唤醒模型；无独立工作时结束当前轮，无需持续查询。`
  }
}
