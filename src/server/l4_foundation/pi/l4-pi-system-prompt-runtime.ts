import 'server-only'

import type {
  AgentSession,
  BeforeAgentStartEvent,
  ExtensionContext
} from '@earendil-works/pi-coding-agent'

function appendPrompt(base: string, append: string): string {
  return append.length > 0 ? (base.length > 0 ? `${base}\n\n${append}` : append) : base
}

/** 单会话持有原有基线和任务追加快照，不从完整正文反推追加的归属。 */
export class L4PiSystemPromptRuntime {
  private snapshot: { baseSystemPrompt: string; appendSystemPrompt: string } | null = null
  private pendingAppend: string | null = null
  private disposed = false

  constructor(private readonly readAppend: () => Promise<string>) {}

  async start(context: ExtensionContext): Promise<void> {
    this.pendingAppend = null
    try {
      const append = await this.readAppend()
      if (!this.disposed) this.pendingAppend = append
    } catch (cause) {
      // Pi 会报告扩展错误后继续派发；读取失败必须同时取消任务，不能静默漏掉指令。
      context.abort()
      throw cause
    }
  }

  apply(event: BeforeAgentStartEvent): void {
    if (this.disposed || this.pendingAppend === null) return
    this.snapshot = {
      baseSystemPrompt: event.systemPrompt,
      appendSystemPrompt: this.pendingAppend
    }
    this.pendingAppend = null
    if (this.snapshot.appendSystemPrompt.length > 0) {
      const options = event.systemPromptOptions
      if (options.forceSystemPrompt !== undefined) {
        options.forceSystemPrompt = appendPrompt(
          options.forceSystemPrompt,
          this.snapshot.appendSystemPrompt
        )
      } else {
        options.appendSystemPrompt = appendPrompt(
          options.appendSystemPrompt,
          this.snapshot.appendSystemPrompt
        )
      }
    }
  }

  preview(
    session: AgentSession,
    appendSystemPrompt: string
  ): { baseSystemPrompt: string; systemPrompt: string } {
    const baseSystemPrompt = this.snapshot?.baseSystemPrompt ?? session.systemPrompt
    return {
      baseSystemPrompt,
      systemPrompt: appendPrompt(baseSystemPrompt, appendSystemPrompt)
    }
  }

  reset(): void {
    this.snapshot = null
    this.pendingAppend = null
  }

  dispose(): void {
    this.disposed = true
    this.reset()
  }
}
