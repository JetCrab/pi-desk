import 'server-only'

import { access, readFile, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { defineTool, getAgentDir, truncateHead } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import type { AgentToolResult } from '@earendil-works/pi-agent-core'
import { getL4PiDeskDataDir } from '@server/l4_foundation/pi/l4-pi-desk-data-dir'
import { isL4PiDeskSafeMode } from '@server/l4_foundation/pi/l4-pi-desk-mode'
import { parseL4PiDeskCommand, type L4PiDeskCommand } from './l4-pidesk-command'
import { renderL4PiDeskSystemPrompt } from './l4-pidesk-system-prompt'

export interface L4PiDeskCommandResult {
  mode: 'sync' | 'async'
  message: string
}

export interface L4PiDeskCommandContext {
  cwd: string
  signal: AbortSignal
  notify: (message: string) => Promise<void>
}

export type L4PiDeskPluginCommand = Extract<L4PiDeskCommand, { kind: 'plugins' }>
export type L4PiDeskPluginCommandHandler = (
  command: L4PiDeskPluginCommand,
  context: L4PiDeskCommandContext
) => Promise<L4PiDeskCommandResult>

interface CommandRuntime {
  handler: L4PiDeskPluginCommandHandler
  systemPrompt: string
  docsDirectory: string
  version: string
  development: boolean
  agentDir: string
}

function portable(path: string): string {
  return path.replaceAll('\\', '/')
}

export async function initializeL4PiDeskCommands(
  handler: L4PiDeskPluginCommandHandler,
  development = process.env.NODE_ENV !== 'production'
): Promise<void> {
  const agentDir = getAgentDir()
  const hostRoot = process.cwd()
  const manifest: unknown = JSON.parse(await readFile(join(hostRoot, 'package.json'), 'utf8'))
  if (
    !manifest ||
    typeof manifest !== 'object' ||
    !('version' in manifest) ||
    typeof manifest.version !== 'string'
  ) {
    throw new Error('Pi Desk package.json 缺少版本号')
  }
  // SDK 文档必须定位到当前安装目录；静态 createRequire 会被 Webpack 改写为数字模块 ID。
  const { createRequire } = process.getBuiltinModule('module')
  const sdkRoot = dirname(
    dirname(createRequire(join(hostRoot, 'package.json')).resolve('@jetcrab/pi-desk-sdk'))
  )
  const docsDirectory = join(hostRoot, 'docs', 'pi-desk')
  await Promise.all(
    ['README.md', 'commands.md', 'plugins.md'].map((file) => access(join(docsDirectory, file)))
  )
  // 只清理当前环境曾生成的宿主 Skill，用户 Skills 和其他宿主环境保持不变。
  await rm(join(getL4PiDeskDataDir(), development ? 'dev-skills' : 'skills', 'pi-desk'), {
    recursive: true,
    force: true
  })
  const runtime: CommandRuntime = {
    handler,
    docsDirectory,
    systemPrompt: renderL4PiDeskSystemPrompt({
      docsDirectory: portable(docsDirectory),
      sdkRoot: portable(sdkRoot)
    }),
    version: manifest.version,
    development,
    agentDir
  }
  globalThis.__piDeskCommandRuntime = runtime
  console.info('[Pi Desk][Commands] 命令入口与系统资料导航已准备完成', { docsDirectory })
}

export function disposeL4PiDeskCommands(): void {
  globalThis.__piDeskCommandRuntime = undefined
}

export function appendL4PiDeskSystemPrompt(prompts: readonly string[] = []): string[] {
  const prompt = globalThis.__piDeskCommandRuntime?.systemPrompt
  return prompt ? [...prompts, prompt] : [...prompts]
}

export async function executeL4PiDeskCommand(
  args: readonly string[],
  context: L4PiDeskCommandContext & { reload: () => L4PiDeskCommandResult }
): Promise<L4PiDeskCommandResult> {
  const runtime = globalThis.__piDeskCommandRuntime
  if (!runtime) throw new Error('Pi Desk 命令入口尚未准备完成')
  context.signal.throwIfAborted()
  const command = parseL4PiDeskCommand(args)
  if (command.kind === 'help') return { mode: 'sync', message: command.message }
  if (command.kind === 'version') return { mode: 'sync', message: runtime.version }
  if (command.kind === 'info') {
    return {
      mode: 'sync',
      message: JSON.stringify({
        version: runtime.version,
        environment: runtime.development ? 'development' : 'production',
        mode: isL4PiDeskSafeMode() ? 'basic' : 'normal',
        cwd: context.cwd,
        agentDir: runtime.agentDir,
        docsDirectory: runtime.docsDirectory
      })
    }
  }
  if (command.kind === 'session') return context.reload()
  if (command.kind !== 'plugins') throw new Error('Pi Desk 命令无效')
  return runtime.handler(command, context)
}

const toolParameters = Type.Object(
  { args: Type.Array(Type.String({ minLength: 1, maxLength: 2048 }), { maxItems: 32 }) },
  { additionalProperties: false }
)
type PiDeskTool = ReturnType<typeof defineTool<typeof toolParameters, L4PiDeskCommandResult>>

export function createL4PiDeskTool(
  execute: (args: string[], toolCallId: string) => Promise<L4PiDeskCommandResult>
): PiDeskTool | null {
  if (!globalThis.__piDeskCommandRuntime) return null
  return defineTool({
    name: 'pidesk',
    exposure: 'model-only',
    label: 'Pi Desk',
    description: 'Pi Desk 命令入口。',
    parameters: toolParameters,
    async execute(toolCallId, input): Promise<AgentToolResult<L4PiDeskCommandResult>> {
      const result = await execute(input.args, toolCallId)
      const truncated = truncateHead(result.message)
      const output = {
        mode: result.mode,
        message: truncated.truncated ? `${truncated.content}\n…结果过长，已截断。` : result.message
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(output) }], details: output }
    }
  })
}

declare global {
  var __piDeskCommandRuntime: CommandRuntime | undefined
}
