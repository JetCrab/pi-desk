import 'server-only'

import { createHash } from 'node:crypto'
import { readFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { CapabilityModeKeySchema } from '@jetcrab/pi-desk-sdk/capabilities'
import {
  getConfigDirectory,
  withConfigTransaction,
  writeConfigTextAtomic
} from '@jetcrab/pi-desk-sdk/config'

/** 串行与跨资源回滚由 L4CapabilityModesStore 负责；此处只操作固定资源。 */
export class L4SystemPromptStore {
  constructor(private readonly agentDir?: string) {}

  private path(modeKey?: string): string {
    const directory = join(getConfigDirectory(this.agentDir), 'system-prompts')
    if (modeKey === undefined) return join(directory, 'global-append.md')
    CapabilityModeKeySchema.parse(modeKey)
    const filename = createHash('sha256').update(modeKey, 'utf8').digest('hex')
    return join(directory, 'modes', `${filename}.md`)
  }

  read(modeKey?: string): Promise<string | null> {
    const path = this.path(modeKey)
    return withConfigTransaction(path, async () => {
      try {
        return readFileSync(path, 'utf8')
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw cause
      }
    })
  }

  replace(content: string | null, modeKey?: string): Promise<void> {
    const path = this.path(modeKey)
    return withConfigTransaction(path, async () => {
      if (content !== null) {
        writeConfigTextAtomic(path, content)
        return
      }
      try {
        unlinkSync(path)
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause
      }
    })
  }
}
