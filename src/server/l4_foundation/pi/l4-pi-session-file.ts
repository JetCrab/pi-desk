import 'server-only'

import { randomUUID } from 'node:crypto'
import { existsSync, linkSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { SessionManager } from '@earendil-works/pi-coding-agent'

/** Materialize SDK-generated session state, then let SessionManager reopen it authoritatively. */
export function materializeL4PiSessionFile(sessionManager: SessionManager): string {
  const sessionFile = sessionManager.getSessionFile()
  if (!sessionFile) throw new Error('Persisted Pi session is missing a session file')
  if (existsSync(sessionFile)) return sessionFile

  const header = sessionManager.getHeader()
  if (!header || header.id !== sessionManager.getSessionId()) {
    throw new Error(`Pi session ${sessionManager.getSessionId()} has an invalid header`)
  }

  mkdirSync(dirname(sessionFile), { recursive: true })
  const content = `${[header, ...sessionManager.getEntries()]
    .map((entry) => JSON.stringify(entry))
    .join('\n')}\n`
  const temporaryFile = `${sessionFile}.${randomUUID()}.tmp`

  try {
    writeFileSync(temporaryFile, content, { encoding: 'utf8', flag: 'wx' })
    try {
      linkSync(temporaryFile, sessionFile)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  } finally {
    if (existsSync(temporaryFile)) unlinkSync(temporaryFile)
  }

  if (!existsSync(sessionFile)) {
    throw new Error(`Failed to materialize Pi session: ${sessionManager.getSessionId()}`)
  }
  return sessionFile
}
