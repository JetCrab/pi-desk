import 'server-only'

import type { PluginMessageProjectionResult } from '@jetcrab/pi-desk-sdk/entry'
import { projectL4PiMessageDeclarationCore } from './l4-pi-message-declaration-core'
import { getL4PiGlobalPluginRuntime } from './l4-pi-global-plugin-runtime'

export function projectL4PiMessageDeclaration(
  input: Parameters<typeof projectL4PiMessageDeclarationCore>[0]
): PluginMessageProjectionResult {
  return projectL4PiMessageDeclarationCore({
    ...input,
    declarations: input.declarations ?? getL4PiGlobalPluginRuntime().readMessageDeclarations()
  })
}
