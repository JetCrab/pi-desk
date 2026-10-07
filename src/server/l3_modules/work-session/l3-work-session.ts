import 'server-only'

import type { ThinkingLevel } from '@earendil-works/pi-agent-core'
import { L4PiWorkSessionRuntime } from '@server/l4_foundation/pi/l4-pi-work-session-runtime'

export interface WorkSessionInputImage {
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif'
  data: string
  width: number
  height: number
}

export interface WorkSessionSendInput {
  mode: 'auto' | 'follow_up'
  text: string
  images: WorkSessionInputImage[]
}

export interface WorkSessionModelInput {
  provider: string
  modelId: string
  thinkingLevel: ThinkingLevel
}

export interface WorkSessionBranchResult {
  changed: boolean
  editorText: string | null
}

export interface WorkSessionCreateBranchedInput {
  position: 'before' | 'at'
  entryId?: string
}

export interface WorkSessionCreateBranchedResult {
  workSession: WorkSession
  editorText: string | null
}

/** Clean orchestration boundary for one active Pi work session. */
export class WorkSession {
  private constructor(
    public readonly workId: string,
    private readonly runtime: L4PiWorkSessionRuntime
  ) {}

  static async create(workId: string, cwd: string, sessionId?: string): Promise<WorkSession> {
    const runtime = sessionId
      ? await L4PiWorkSessionRuntime.open(cwd, sessionId)
      : L4PiWorkSessionRuntime.create(cwd)
    return new WorkSession(workId, runtime)
  }

  get cwd(): string {
    return this.runtime.cwd
  }

  get sessionId(): string {
    return this.runtime.sessionId
  }

  get branchId(): string {
    return this.runtime.branchId
  }

  async branch(entryId: string): Promise<WorkSessionBranchResult> {
    const result = await this.runtime.branch(entryId)
    return { changed: result.changed, editorText: result.editorText }
  }

  async createBranchedSession(
    workId: string,
    input: WorkSessionCreateBranchedInput
  ): Promise<WorkSessionCreateBranchedResult> {
    const result = this.runtime.createBranchedSession(input)
    return {
      workSession: new WorkSession(workId, result.runtime),
      editorText: result.editorText
    }
  }

  async send(input: WorkSessionSendInput): Promise<{ tempId: string }> {
    return this.runtime.send(input)
  }

  async interrupt(): Promise<void> {
    await this.runtime.interrupt()
  }

  async restoreQueuedMessages(): Promise<{ text: string; images: WorkSessionInputImage[] }> {
    return this.runtime.restoreQueuedMessages()
  }

  async setModel(input: WorkSessionModelInput): Promise<void> {
    await this.runtime.setModel(input)
  }
}
