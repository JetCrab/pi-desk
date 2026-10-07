import 'server-only'

import type { L4LocalizedText } from '@common/l4_foundation/locale/l4-localized-text'

export type L4WorkSessionGitErrorKind =
  | 'project-not-found'
  | 'not-repository'
  | 'outside-project'
  | 'invalid-ref'
  | 'scan-limit'
  | 'operation-failed'
  | 'read-failed'

export class L4WorkSessionGitError extends Error {
  constructor(
    readonly kind: L4WorkSessionGitErrorKind,
    message: string,
    readonly localizedMessage?: L4LocalizedText
  ) {
    super(message)
    this.name = 'L4WorkSessionGitError'
  }
}

export function getL4WorkSessionGitErrorKind(error: unknown): L4WorkSessionGitErrorKind | null {
  return error instanceof L4WorkSessionGitError ? error.kind : null
}
