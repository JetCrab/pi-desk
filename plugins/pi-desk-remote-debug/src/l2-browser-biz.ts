import type { BrowserPluginHost, PluginJsonObject } from '@jetcrab/pi-desk-sdk/browser'
import {
  remoteDebugRangesSchema,
  remoteDebugSettingsSchema,
  type RemoteDebugSettings,
  type RemoteDebugRegistration
} from './l4-remote-debug-contract.js'
import type { RemoteDebugProject, RemoteDebugRun } from './runtime.js'

export interface RangeEditor {
  localStart: string
  localEnd: string
  publicStart: string
  publicEnd: string
}

export function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

export async function getCatalog(host: BrowserPluginHost): Promise<RemoteDebugProject[]> {
  const value = await host.piDesk.invokeGlobal('catalog-get', {})
  if (!Array.isArray(value.projects)) throw new Error('项目列表响应无效')
  return value.projects as unknown as RemoteDebugProject[]
}

export async function getSettings(host: BrowserPluginHost): Promise<RemoteDebugSettings> {
  return remoteDebugSettingsSchema.parse(await host.piDesk.invokeGlobal('settings-get', {}))
}

export function editRanges(settings: RemoteDebugSettings): RangeEditor {
  return {
    localStart: String(settings.localRange.start),
    localEnd: String(settings.localRange.end),
    publicStart: String(settings.publicRange.start),
    publicEnd: String(settings.publicRange.end)
  }
}

function port(value: string, label: string): number | null {
  if (!value.trim()) return null
  if (!/^\d+$/.test(value.trim())) throw new Error(`${label}请填写 1–65535 的整数`)
  const result = Number(value)
  if (result < 1 || result > 65535) throw new Error(`${label}请填写 1–65535 的整数`)
  return result
}

export async function saveRanges(
  host: BrowserPluginHost,
  editor: RangeEditor
): Promise<RemoteDebugSettings> {
  const input = remoteDebugRangesSchema.parse({
    localRange: {
      start: port(editor.localStart, '本机起始端口'),
      end: port(editor.localEnd, '本机结束端口')
    },
    publicRange: {
      start: port(editor.publicStart, '公网起始端口'),
      end: port(editor.publicEnd, '公网结束端口')
    }
  })
  return remoteDebugSettingsSchema.parse(await host.piDesk.invokeGlobal('settings-save', input))
}

export async function deleteRegistration(
  host: BrowserPluginHost,
  item: RemoteDebugRegistration
): Promise<RemoteDebugSettings> {
  return remoteDebugSettingsSchema.parse(
    await host.piDesk.invokeGlobal('registration-delete', {
      cwd: item.cwd,
      profile: item.profile,
      tunnelServer: item.tunnelServer
    })
  )
}

export function readRuns(value: PluginJsonObject | null): RemoteDebugRun[] {
  if (!value || !Array.isArray(value.runs)) return []
  return value.runs.filter(
    (run) => run && typeof run === 'object' && !Array.isArray(run) && typeof run.runId === 'string'
  ) as unknown as RemoteDebugRun[]
}

export function isActiveRun(run: RemoteDebugRun): boolean {
  return run.status === 'starting' || run.status === 'running' || run.status === 'stopping'
}

export async function startProfile(
  host: BrowserPluginHost,
  cwd: string,
  profile: string
): Promise<void> {
  await host.piDesk.invokeGlobal('run-start', { cwd, profile })
}

export async function stopRun(host: BrowserPluginHost, runId: string): Promise<void> {
  await host.piDesk.invokeGlobal('run-stop', { runId })
}

export async function restartProfile(host: BrowserPluginHost, run: RemoteDebugRun): Promise<void> {
  await stopRun(host, run.runId)
  await startProfile(host, run.cwd, run.profile)
}

export async function sendFailureToAi(host: BrowserPluginHost, run: RemoteDebugRun): Promise<void> {
  const workSession = await host.workSessions.create({ cwd: run.cwd })
  const prompt = `远程调试失败，请分析并处理。\n\n项目：${run.cwd}\nProfile：${run.profile}\n错误：${run.failure?.message ?? '未知'}\n日志：${run.logPath}`
  await host.pi.prompt(workSession.source, { mode: 'auto', text: prompt })
  host.notify({ level: 'success', title: '已发送给 AI' })
}

export function projectName(cwd: string): string {
  return (
    cwd
      .replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .pop() || cwd
  )
}
