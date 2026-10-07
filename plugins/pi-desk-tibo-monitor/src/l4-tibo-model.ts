import { contentText } from '@earendil-works/pi-ai'
import type { HostRegion } from '@jetcrab/pi-desk-sdk/settings'
import {
  getAgentDir,
  ModelRuntime,
  resolveModelScopeWithDiagnostics,
  SettingsManager
} from '@earendil-works/pi-coding-agent'
import {
  analysisSchema,
  type ModelSelection,
  type TiboAnalysis,
  type TiboModelOption,
  type TiboPost
} from './l4-tibo-protocol.js'
import { tiboAnalysisPrompt, tiboAnalysisInput } from './l4-tibo-prompt.js'

export function parseAnalysis(text: string): TiboAnalysis {
  const trimmed = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
  let value: unknown
  try {
    value = JSON.parse(trimmed)
  } catch {
    throw new Error('模型未返回有效分析 JSON，请重试或更换模型')
  }
  const parsed = analysisSchema.safeParse(value)
  if (!parsed.success) throw new Error(`模型分析结构无效：${parsed.error.issues[0]?.message}`)
  return parsed.data
}

export class TiboModels {
  private current: Promise<ModelRuntime> | null = null

  private runtime(refresh = false): Promise<ModelRuntime> {
    if (!this.current || refresh) {
      // 列表刷新替换实例，不在进行中的模型请求上修改 Provider 配置。
      this.current = ModelRuntime.create({ allowModelNetwork: false }).then((runtime) => {
        const error = runtime.getError()
        if (error) throw new Error(error)
        return runtime
      })
    }
    return this.current
  }

  async list(): Promise<TiboModelOption[]> {
    const runtime = await this.runtime(true)
    const patterns = SettingsManager.create(process.cwd(), getAgentDir()).getGlobalSettings()
      .enabledModels
    const available = patterns?.length
      ? (await resolveModelScopeWithDiagnostics(patterns, runtime)).scopedModels.map(
          (item) => item.model
        )
      : await runtime.getAvailable()
    const unique = new Map<string, TiboModelOption>()
    for (const model of available) {
      if (!model.input.includes('text')) continue
      unique.set(`${model.provider}\0${model.id}`, {
        provider: model.provider,
        modelId: model.id,
        name: model.name
      })
    }
    return [...unique.values()].sort((a, b) =>
      `${a.provider}/${a.modelId}`.localeCompare(`${b.provider}/${b.modelId}`)
    )
  }

  async translate(
    post: TiboPost,
    selection: ModelSelection,
    signal: AbortSignal,
    region: HostRegion
  ): Promise<TiboAnalysis> {
    const runtime = await this.runtime()
    signal.throwIfAborted()
    const model = runtime.getModel(selection.provider, selection.modelId)
    if (!model) throw new Error(`翻译模型不存在：${selection.provider}/${selection.modelId}`)
    const response = await runtime.completeSimple(
      model,
      {
        systemPrompt: tiboAnalysisPrompt(region),
        messages: [{ role: 'user', content: tiboAnalysisInput(post), timestamp: Date.now() }]
      },
      {
        signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
        maxTokens: Math.min(model.maxTokens, 6000)
      }
    )
    signal.throwIfAborted()
    if (response.stopReason !== 'stop') {
      throw new Error(
        `翻译未正常完成（${response.stopReason}）${response.errorMessage ? `：${response.errorMessage}` : ''}`
      )
    }
    const analysis = parseAnalysis(contentText(response.content))
    if (post.quote && !analysis.quoteTranslation) throw new Error('模型未返回引用帖译文，请重试')
    return analysis
  }
}
