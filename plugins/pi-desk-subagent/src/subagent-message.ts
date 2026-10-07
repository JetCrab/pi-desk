export const SUBAGENT_COMPLETION_CUSTOM_TYPE = 'pi-desk-subagent:completion:v1'
export const SUBAGENT_LAUNCH_STATE_CUSTOM_TYPE = 'pi-desk-subagent:launch:v1'
export const SUBAGENT_SHUTDOWN_STATE_CUSTOM_TYPE = 'pi-desk-subagent:state:v1'
export const SUBAGENT_RECORD_VERSION = 1

export interface SubagentCompletionContent {
  agentType: string | null
  title: string | null
  result: string
}

export function parseSubagentCompletionContent(content: string): SubagentCompletionContent {
  const resultMarker = '\n\n结果:\n'
  const markerIndex = content.indexOf(resultMarker)
  const header = markerIndex >= 0 ? content.slice(0, markerIndex) : content
  const result = markerIndex >= 0 ? content.slice(markerIndex + resultMarker.length).trim() : ''
  const lines = header.split('\n')
  const agentType = lines
    .find((line) => line.startsWith('类型: '))
    ?.slice('类型: '.length)
    .trim()
  const title = lines
    .find((line) => line.startsWith('任务: '))
    ?.slice('任务: '.length)
    .trim()
  return {
    agentType: agentType || null,
    title: title || null,
    result
  }
}
