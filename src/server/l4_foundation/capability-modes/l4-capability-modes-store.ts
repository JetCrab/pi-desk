import 'server-only'

import { lstatSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { bindConfigStore, readConfigSection } from '@jetcrab/pi-desk-sdk/config'
import {
  CapabilityModeKeySchema,
  CapabilityModesSchema as L3CapabilityModesSchema,
  type CapabilityModes as L3CapabilityModes
} from '@jetcrab/pi-desk-sdk/capabilities'
import { L4SystemPromptStore } from './l4-system-prompt-store'

export class L4CapabilityModesInputError extends Error {
  override readonly name = 'L4CapabilityModesInputError'
}

type DefaultMode = { defaultMode?: string | null }
const defaultModeSchema = CapabilityModeKeySchema.nullable().optional()

export class L4CapabilityModesStore {
  private modes: L3CapabilityModes | null = null
  private readonly listeners = new Set<() => void>()
  private tail: Promise<void> = Promise.resolve()
  private readonly prompts: L4SystemPromptStore

  constructor(private readonly agentDir?: string) {
    this.prompts = new L4SystemPromptStore(agentDir)
  }

  read(): L3CapabilityModes {
    if (this.modes === null) {
      const saved = readConfigSection('pi-desk', 'capability-modes', this.agentDir)
      this.modes = L3CapabilityModesSchema.parse(saved.modes === undefined ? {} : saved.modes)
    }
    return structuredClone(this.modes)
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return (): void => {
      this.listeners.delete(listener)
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.tail.then(operation)
    this.tail = pending.then(
      () => undefined,
      () => undefined
    )
    return pending
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener()
      } catch (cause) {
        console.error('[Pi Desk][Capabilities] 模式配置监听器失败', {
          message: cause instanceof Error ? cause.message : String(cause)
        })
      }
    }
  }

  private config(): ReturnType<typeof bindConfigStore> {
    return bindConfigStore('pi-desk', 'capability-modes', { agentDir: this.agentDir })
  }

  private requireMode(modeKey: string, modes = this.read()): L3CapabilityModes[string] {
    if (!Object.hasOwn(modes, modeKey)) {
      throw new L4CapabilityModesInputError(`能力模式不存在：${modeKey}`)
    }
    return modes[modeKey]
  }

  replace(input: L3CapabilityModes, promptContents?: Record<string, string>): Promise<void> {
    const next = L3CapabilityModesSchema.parse(input)
    const contents = structuredClone(promptContents ?? {})
    return this.enqueue(async () => {
      for (const key of Object.keys(contents)) this.requireMode(key, next)
      const config = this.config()
      const previous = await config.get({ inherit: false })
      const previousModes = L3CapabilityModesSchema.parse(
        previous.modes === undefined ? {} : previous.modes
      )
      const changes = new Map<string, string | null>(Object.entries(contents))
      for (const key of Object.keys(previousModes)) {
        if (!Object.hasOwn(next, key)) changes.set(key, null)
      }
      for (const [key, mode] of Object.entries(next)) {
        if (mode.promptSource === 'custom' && !Object.hasOwn(contents, key)) {
          if (Object.hasOwn(previousModes, key) && previousModes[key].promptSource === 'custom') {
            await this.readRequiredPrompt(key)
          } else if ((await this.prompts.read(key)) === null) {
            changes.set(key, '')
          }
        }
      }
      const snapshots = new Map<string, string | null>()
      for (const key of changes.keys()) snapshots.set(key, await this.prompts.read(key))
      const saved: typeof previous = { ...previous, modes: next }
      if (typeof previous.defaultMode === 'string' && !Object.hasOwn(next, previous.defaultMode)) {
        saved.defaultMode = null
      }
      const touched: string[] = []
      let configAttempted = false
      try {
        for (const [key, content] of changes) {
          // 原子写可能在发布后的校验阶段失败，所以尝试过的目标也必须恢复。
          touched.push(key)
          await this.prompts.replace(content, key)
        }
        configAttempted = true
        await config.set(saved)
      } catch (cause) {
        const failures: unknown[] = []
        if (configAttempted) {
          try {
            if (!isDeepStrictEqual(await config.get({ inherit: false }), previous)) {
              await config.set(previous)
            }
          } catch (error) {
            failures.push(error)
          }
        }
        for (const key of touched.reverse()) {
          try {
            const previousContent = snapshots.get(key)!
            if ((await this.prompts.read(key)) !== previousContent) {
              await this.prompts.replace(previousContent, key)
            }
          } catch (error) {
            failures.push(error)
          }
        }
        if (failures.length) {
          this.modes = null
          console.error('[Pi Desk][Capabilities] 模式保存失败且局部回滚未完成', {
            modeKeys: touched,
            errors: failures.map((error) =>
              error instanceof Error ? error.message : String(error)
            )
          })
          throw new AggregateError(
            [cause, ...failures],
            '能力模式保存失败且局部回滚未完成，配置状态可能已改变，请重新读取'
          )
        }
        throw cause
      }
      this.modes = structuredClone(next)
      this.notify()
    })
  }

  private async readRequiredPrompt(modeKey: string): Promise<string> {
    const content = await this.prompts.read(modeKey)
    if (content === null) {
      throw new Error(`能力模式自定义提示词文件缺失：${modeKey}；请重新保存正文`)
    }
    return content
  }

  readPrompt(modeKey?: string): Promise<string> {
    return this.enqueue(async () => {
      if (modeKey === undefined) return (await this.prompts.read()) ?? ''
      const mode = this.requireMode(modeKey)
      return mode.promptSource === 'custom'
        ? this.readRequiredPrompt(modeKey)
        : ((await this.prompts.read(modeKey)) ?? '')
    })
  }

  replaceGlobalPrompt(content: string): Promise<void> {
    return this.enqueue(async () => {
      const previous = await this.prompts.read()
      try {
        await this.prompts.replace(content)
      } catch (cause) {
        try {
          if ((await this.prompts.read()) !== previous) {
            await this.prompts.replace(previous)
          }
        } catch (rollback) {
          throw new AggregateError(
            [cause, rollback],
            '全局提示词保存失败且局部回滚未完成，请重新读取'
          )
        }
        throw cause
      }
      this.notify()
    })
  }

  private projectOptions(cwd: string | null): { cwd?: string; inherit: false } {
    if (cwd === null) return { inherit: false }
    if (!isAbsolute(cwd) || cwd.includes('\0')) {
      throw new L4CapabilityModesInputError('项目 cwd 必须是已存在的绝对普通目录')
    }
    try {
      if (!lstatSync(cwd).isDirectory()) {
        throw new L4CapabilityModesInputError('项目 cwd 必须是已存在的绝对普通目录')
      }
    } catch (cause) {
      if (['ENOENT', 'ENOTDIR'].includes((cause as NodeJS.ErrnoException).code ?? '')) {
        throw new L4CapabilityModesInputError('项目 cwd 必须是已存在的绝对普通目录')
      }
      throw cause
    }
    return { cwd, inherit: false }
  }

  private async readDefaultLayer(cwd: string | null): Promise<DefaultMode> {
    const saved = await this.config().get(this.projectOptions(cwd))
    const defaultMode = defaultModeSchema.parse(saved.defaultMode)
    return defaultMode === undefined ? (cwd === null ? { defaultMode: null } : {}) : { defaultMode }
  }

  readDefault(cwd: string | null): Promise<DefaultMode> {
    return this.enqueue(() => this.readDefaultLayer(cwd))
  }

  replaceDefault(input: { cwd: string | null; defaultMode?: string | null }): Promise<void> {
    return this.enqueue(async () => {
      const options = this.projectOptions(input.cwd)
      if (input.cwd === null && input.defaultMode === undefined) {
        throw new L4CapabilityModesInputError('保存全局默认模式必须显式指定 defaultMode')
      }
      if (typeof input.defaultMode === 'string') this.requireMode(input.defaultMode)
      const config = this.config()
      const saved = await config.get(options)
      if (input.defaultMode === undefined) delete saved.defaultMode
      else saved.defaultMode = input.defaultMode
      await config.set(saved, input.cwd === null ? {} : { cwd: input.cwd })
    })
  }

  resolveDefault(cwd: string): Promise<string | null> {
    return this.enqueue(async () => {
      const modes = this.read()
      for (const scope of [cwd, null]) {
        const { defaultMode } = await this.readDefaultLayer(scope)
        if (defaultMode === null) return null
        if (defaultMode === undefined) continue
        if (Object.hasOwn(modes, defaultMode)) return defaultMode
        console.warn('[Pi Desk][Capabilities] 默认模式引用失效，按优先级回退', {
          cwd: scope,
          modeKey: defaultMode
        })
      }
      return null
    })
  }

  resolvePrompt(modeKey: string | null): Promise<string> {
    return this.enqueue(async () => {
      if (modeKey === null) return (await this.prompts.read()) ?? ''
      const mode = this.requireMode(modeKey)
      if (mode.promptSource === 'none') return ''
      if (mode.promptSource === 'custom') return this.readRequiredPrompt(modeKey)
      return (await this.prompts.read()) ?? ''
    })
  }
}

export function getL4CapabilityModesStore(): L4CapabilityModesStore {
  return (globalThis.__piDeskCapabilityModesStore ??= new L4CapabilityModesStore())
}

declare global {
  var __piDeskCapabilityModesStore: L4CapabilityModesStore | undefined
}
