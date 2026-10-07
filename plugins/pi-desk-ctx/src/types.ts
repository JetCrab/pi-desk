export const CONTEXT_IGNORE_ENTRY_TYPE = 'context-ignore-state'
export const DEFAULT_KEEP_TURNS = 3

export type ContextIgnoreMode = 'user-turns' | 'internal-turns' | 'combined'

export interface ContextInternalTurnCutoff {
  cutoffTimestamp: number
  /** Undefined keeps the legacy subagent-wide internal boundary. */
  userTimestamp?: number
}

export interface ContextIgnoreState {
  enabled: boolean
  /** User-turn cutoff. Messages before it have their process details replaced. */
  cutoffTimestamp?: number
  /** Scoped internal boundaries compose with the user-turn boundary. */
  internalTurnCutoffs?: ContextInternalTurnCutoff[]
  mode?: ContextIgnoreMode
  pendingUsageRefreshAfterTimestamp?: number
  /** 自动忽略后、下一次真实模型用量返回前的 Provider 上下文预估。 */
  estimatedContextTokens?: number
  /** Pi 已发现的目录型 Skill 根目录，供恢复会话继续豁免。 */
  skillBaseDirs?: string[]
  /** Pi 已发现的根目录直放 Markdown Skill 文件，避免放宽其父目录。 */
  skillFilePaths?: string[]
  keepTurns: number
  /** 仅用于读取旧会话中固定内部轮次策略的状态。 */
  keepInternalTurns?: number
  updatedAt: number
}

export interface ContextIgnorePotential {
  reasoningReplayTokens: number
  netTokens: number
  providerNetTokens: number
}

export interface ContextIgnoreAnalysis {
  rawTokens: number
  effectiveTokens: number
  /** 当前 Provider 上下文的本地估算，包含回放 signature。 */
  providerEffectiveTokens: number
  ignoredTokens: number
  providerIgnoredTokens: number
  reasoningReplayTokens: number
  completeTurns: number
}
