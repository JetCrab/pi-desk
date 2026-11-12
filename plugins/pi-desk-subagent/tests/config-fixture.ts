import type { TestContext } from 'node:test'
import { bindConfigStore } from '@jetcrab/pi-desk-sdk/config'
import type { PluginConfig } from '@jetcrab/pi-desk-sdk/entry'

export function useSubagentConfig(context: TestContext, agentDir: string): PluginConfig {
  const previous = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = agentDir
  context.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previous
  })
  return bindConfigStore('plugins', 'subagent', { agentDir })
}
