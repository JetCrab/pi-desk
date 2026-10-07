import {
  L3ProjectFileReveal,
  type L3ProjectReadContext,
  type L3ProjectRevealTargetType
} from '@common/l3_modules/project-files/l3-project-files-contract'
import { requestL3Project } from './l3-project-reader'

export async function revealL3ProjectPath(
  clientId: string,
  context: L3ProjectReadContext,
  path: string,
  targetType: L3ProjectRevealTargetType
): Promise<void> {
  await requestL3Project(clientId, L3ProjectFileReveal, { ...context, path, targetType })
}

export function absoluteL3ProjectPath(cwd: string, path: string): string {
  const windows = /^[a-zA-Z]:[\\/]/.test(cwd) || cwd.startsWith('\\\\')
  const separator = windows ? '\\' : '/'
  const root = (windows ? cwd.replaceAll('/', '\\') : cwd).replace(/[\\/]+$/, '')
  return path
    ? `${root}${separator}${path.replaceAll('/', separator)}`
    : /^[a-z]:$/i.test(root)
      ? `${root}${separator}`
      : root || separator
}
