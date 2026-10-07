import 'server-only'

import { isAbsolute, relative, resolve, sep } from 'node:path'
import { realpath } from 'node:fs/promises'

export class L4SkillError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409 | 413,
    message: string
  ) {
    super(message)
    this.name = 'L4SkillError'
  }
}

export function skillPathKey(path: string): string {
  const absolute = resolve(path)
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute
}

export function protocolSkillPath(path: string): string {
  return resolve(path).split(sep).join('/')
}

export function insideSkillRoot(root: string, target: string): boolean {
  const path = relative(root, target)
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))
}

export async function existingSkillPath(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      (error.code === 'EACCES' || error.code === 'EPERM')
    ) {
      throw new L4SkillError(403, '没有权限访问 Skill 文件')
    }
    throw new L4SkillError(404, 'Skill 或文件不存在')
  }
}
