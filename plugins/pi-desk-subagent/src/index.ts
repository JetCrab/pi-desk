import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { registerSubagentExtension } from './subagent-runtime.js'

export default function tempLocalSubagent(pi: ExtensionAPI): void {
  registerSubagentExtension(pi)
}
