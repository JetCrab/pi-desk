import 'server-only'

import { isAbsolute, relative, sep } from 'node:path'

export function getL4FileSystemKey(path: string): string {
  return process.platform === 'win32' ? path.toLocaleLowerCase() : path
}

export function isL4PathInsideRoot(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}
