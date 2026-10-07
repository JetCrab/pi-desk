import 'server-only'

import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { access, open, readdir, rename, rm, stat } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import {
  createL4BilingualText,
  type L4LocalizedText
} from '@common/l4_foundation/locale/l4-localized-text'
import {
  L4_PROJECT_FILE_LIST_MAX_ENTRIES,
  L4_PROJECT_TEXT_FILE_MAX_BYTES,
  L4ProjectDirectoryPathSchema,
  L4ProjectFilePathSchema
} from '@common/l4_foundation/file/l4-project-file-contract'
import {
  getL4WorkSessionProjectFile,
  L4WorkSessionProjectFileError,
  type L4WorkSessionProjectFileGet
} from '@server/l4_foundation/file/l4-work-session-project-file'
import type { SkillCatalog, SkillResource } from './l4-skill-catalog'
import { existingSkillPath, insideSkillRoot, L4SkillError, skillPathKey } from './l4-skill-path'

export type SkillFileResult =
  | (Extract<L4WorkSessionProjectFileGet, { kind: 'text' }> & {
      readOnlyReason: L4LocalizedText | null
    })
  | Extract<L4WorkSessionProjectFileGet, { kind: 'image' }>
  | { kind: 'unsupported'; size: number; reason: string }

async function targetFor(
  skill: SkillResource,
  path: string,
  directory: boolean
): Promise<{ root: string; target: string }> {
  const parsed = (directory ? L4ProjectDirectoryPathSchema : L4ProjectFilePathSchema).safeParse(
    path
  )
  if (!parsed.success) throw new L4SkillError(400, 'Skill 内路径必须是规范相对路径')
  const standalone = basename(skill.skillPath) !== 'SKILL.md'
  if (standalone && path !== '' && path !== basename(skill.skillPath))
    throw new L4SkillError(400, '独立 Markdown Skill 只允许访问入口文件自身')
  const root = await existingSkillPath(dirname(skill.skillPath))
  const target = await existingSkillPath(resolve(root, path))
  if (!insideSkillRoot(root, target))
    throw new L4SkillError(400, '目标文件不在此 Skill 的资源目录内')
  return { root, target }
}

async function readOnlyReason(
  catalog: SkillCatalog,
  skill: SkillResource,
  target: string
): Promise<L4LocalizedText | null> {
  if (skill.managed || catalog.managedRoots.some((root) => insideSkillRoot(root, target))) {
    return createL4BilingualText(
      '此文件由 Pi 包管理器维护，请在包的源码目录修改；更新安装包会覆盖这里的内容。',
      'This file is managed by the Pi package manager. Edit the package source; updates will overwrite this copy.'
    )
  }
  try {
    await access(target, constants.W_OK)
    await access(dirname(target), constants.W_OK)
    return null
  } catch {
    return createL4BilingualText(
      '当前服务没有修改此文件或其所在目录的权限。',
      'The service does not have permission to edit this file or its directory.'
    )
  }
}

export async function listSkillFiles(
  skill: SkillResource,
  path: string
): Promise<{ entries: Array<{ name: string; type: 'directory' | 'file' }>; truncated: boolean }> {
  const { root, target } = await targetFor(skill, path, true)
  if (!(await stat(target)).isDirectory()) throw new L4SkillError(400, '目标不是目录')
  if (basename(skill.skillPath) !== 'SKILL.md') {
    return { entries: [{ name: basename(skill.skillPath), type: 'file' }], truncated: false }
  }
  const entries: Array<{ name: string; type: 'directory' | 'file' }> = []
  const children = await readdir(target, { withFileTypes: true })
  for (const child of children) {
    if (
      child.name.includes('\\') ||
      child.name.includes('\0') ||
      child.name.startsWith('.pi-desk-save-')
    )
      continue
    try {
      const actual = child.isSymbolicLink()
        ? await existingSkillPath(join(target, child.name))
        : join(target, child.name)
      if (!insideSkillRoot(root, actual)) continue
      const info = child.isSymbolicLink() ? await stat(actual) : child
      if (info.isDirectory()) entries.push({ name: child.name, type: 'directory' })
      else if (info.isFile()) entries.push({ name: child.name, type: 'file' })
    } catch {
      /* 目录遍历期间消失的链接不作为可打开文件。 */
    }
  }
  entries.sort((a, b) => {
    if (a.name === 'SKILL.md') return -1
    if (b.name === 'SKILL.md') return 1
    return (
      (a.type === b.type ? 0 : a.type === 'directory' ? -1 : 1) ||
      a.name.localeCompare(b.name, 'zh-CN', { numeric: true })
    )
  })
  return {
    entries: entries.slice(0, L4_PROJECT_FILE_LIST_MAX_ENTRIES),
    truncated: entries.length > L4_PROJECT_FILE_LIST_MAX_ENTRIES
  }
}

export async function getSkillFile(
  catalog: SkillCatalog,
  skill: SkillResource,
  path: string
): Promise<SkillFileResult> {
  const { root, target } = await targetFor(skill, path, false)
  const info = await stat(target)
  if (!info.isFile()) throw new L4SkillError(400, '目标不是文件')
  try {
    // 先按 Skill 根约束目标，再复用已有完整文本/图片读取底座。
    const file = await getL4WorkSessionProjectFile(root, target, 'original')
    return file.kind === 'text'
      ? { ...file, readOnlyReason: await readOnlyReason(catalog, skill, target) }
      : file
  } catch (error) {
    if (error instanceof L4WorkSessionProjectFileError) {
      if (error.kind === 'unsupported')
        return {
          kind: 'unsupported',
          size: info.size,
          reason: '此文件不是支持的图片或 UTF-8 文本，不能在 Monaco 中编辑。'
        }
      if (error.kind === 'text-too-large' || error.kind === 'image-too-large')
        throw new L4SkillError(413, '文件超过预览大小限制，不提供截断编辑')
      if (error.kind === 'not-found') throw new L4SkillError(404, '文件已不存在')
    }
    throw error
  }
}

export async function replaceSkillFile(
  catalog: SkillCatalog,
  skill: SkillResource,
  path: string,
  content: string
): Promise<void> {
  if (content.includes('\0')) throw new L4SkillError(400, '不能保存包含空字节的文本')
  if (Buffer.byteLength(content, 'utf8') > L4_PROJECT_TEXT_FILE_MAX_BYTES)
    throw new L4SkillError(413, '提交文本超过大小限制')
  const { target } = await targetFor(skill, path, false)
  const { withFileMutationQueue } = await import('@earendil-works/pi-coding-agent')
  await withFileMutationQueue(target, async () => {
    const current = await targetFor(skill, path, false)
    if (skillPathKey(current.target) !== skillPathKey(target))
      throw new L4SkillError(409, '文件位置已变化，请重新打开后保存')
    const reason = await readOnlyReason(catalog, skill, target)
    if (reason) throw new L4SkillError(403, typeof reason === 'string' ? reason : reason.default)
    const original = await open(target, 'r')
    let bytes: Buffer
    let mode: number
    try {
      const info = await original.stat()
      if (!info.isFile()) throw new L4SkillError(400, '只能替换已有文本文件')
      if (info.size > L4_PROJECT_TEXT_FILE_MAX_BYTES)
        throw new L4SkillError(413, '原文件超过文本编辑限制')
      mode = info.mode
      const buffer = Buffer.alloc(L4_PROJECT_TEXT_FILE_MAX_BYTES + 1)
      let length = 0
      while (length < buffer.length) {
        const read = await original.read(buffer, length, buffer.length - length, null)
        if (read.bytesRead === 0) break
        length += read.bytesRead
      }
      if (length > L4_PROJECT_TEXT_FILE_MAX_BYTES)
        throw new L4SkillError(413, '原文件超过文本编辑限制')
      bytes = buffer.subarray(0, length)
    } finally {
      await original.close()
    }
    let originalText: string
    try {
      if (bytes.includes(0)) throw new Error('binary')
      originalText = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch {
      throw new L4SkillError(400, '只能保存完整的 UTF-8 文本文件')
    }
    const bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
    const lineEnding = originalText.match(/\r\n|\n|\r/)?.[0] ?? '\n'
    const normalized = content
      .replace(/^\uFEFF/, '')
      .replace(/\r\n|\r/g, '\n')
      .replace(/\n/g, lineEnding)
    const output = Buffer.from(`${bom ? '\uFEFF' : ''}${normalized}`, 'utf8')
    if (output.length > L4_PROJECT_TEXT_FILE_MAX_BYTES)
      throw new L4SkillError(413, '保存后的文件超过文本大小限制')
    const temporary = join(dirname(target), `.pi-desk-save-${randomUUID()}`)
    try {
      const handle = await open(temporary, 'wx', mode)
      try {
        await handle.writeFile(output)
        await handle.chmod(mode & 0o777)
        await handle.sync()
      } finally {
        await handle.close()
      }
      // replace 不能在目标消失后意外变成 create。
      await stat(target)
      await rename(temporary, target)
    } finally {
      await rm(temporary, { force: true })
    }
  })
}
