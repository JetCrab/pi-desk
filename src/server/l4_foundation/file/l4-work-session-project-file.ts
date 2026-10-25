import 'server-only'

import { spawn } from 'node:child_process'
import { open, readFile, readdir, realpath, stat } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'
import sharp from 'sharp'
import {
  L4_PROJECT_FILE_LIST_MAX_ENTRIES,
  L4_PROJECT_IMAGE_FILE_MAX_BYTES,
  L4_PROJECT_IMAGE_MAX_PIXELS,
  L4_PROJECT_TEXT_FILE_MAX_BYTES,
  type L4ProjectFileEntry,
  type L4ProjectFileList,
  type L4ProjectFileContent,
  type L4ProjectFileImageMimeType,
  type L4ProjectFileImagePreviewMode
} from '@common/l4_foundation/file/l4-project-file-contract'
import { isL4PathInsideRoot as isInsideRoot } from './l4-file-path'
import {
  IGNORED_NAMES,
  invalidateSearchIndex,
  isSupportedProtocolName
} from './l4-project-file-index'

const IMAGE_COMPRESSION_MIN_BYTES = 512 * 1024
const IMAGE_COMPRESSION_MAX_WIDTH = 2560
const IMAGE_COMPRESSION_MIN_SAVING_RATIO = 0.15

export type L4WorkSessionProjectFileErrorKind =
  | 'not-found'
  | 'not-directory'
  | 'not-file'
  | 'outside-project'
  | 'text-too-large'
  | 'image-too-large'
  | 'unsupported'
  | 'read-failed'
  | 'reveal-failed'

export class L4WorkSessionProjectFileError extends Error {
  constructor(
    readonly kind: L4WorkSessionProjectFileErrorKind,
    message: string
  ) {
    super(message)
    this.name = 'L4WorkSessionProjectFileError'
  }
}

export function getL4WorkSessionProjectFileErrorKind(
  error: unknown
): L4WorkSessionProjectFileErrorKind | null {
  return error instanceof L4WorkSessionProjectFileError ? error.kind : null
}

export type L4WorkSessionProjectFileEntry = L4ProjectFileEntry
export type L4WorkSessionProjectFileList = L4ProjectFileList
export type L4WorkSessionProjectFileGet = L4ProjectFileContent

interface ProjectFileRevealTarget {
  target: string
  directory: string
  exists: boolean
}

type ProjectFileRevealRunner = (command: string, args: string[]) => Promise<void>

async function resolveProjectRoot(cwd: string): Promise<string> {
  try {
    const root = await realpath(cwd)
    if (!(await stat(root)).isDirectory()) {
      throw new L4WorkSessionProjectFileError(
        'not-directory',
        `Project root is not a directory: ${cwd}`
      )
    }
    return root
  } catch (error) {
    if (error instanceof L4WorkSessionProjectFileError) throw error
    throw new L4WorkSessionProjectFileError('not-found', `Project root was not found: ${cwd}`)
  }
}

async function resolveExistingProjectPath(root: string, protocolPath: string): Promise<string> {
  const unresolved = protocolPath ? resolve(root, ...protocolPath.split('/')) : root
  if (!isInsideRoot(root, unresolved)) {
    throw new L4WorkSessionProjectFileError(
      'outside-project',
      `Project path escapes root: ${protocolPath}`
    )
  }

  try {
    const target = await realpath(unresolved)
    if (!isInsideRoot(root, target)) {
      throw new L4WorkSessionProjectFileError(
        'outside-project',
        `Project path resolves outside root: ${protocolPath}`
      )
    }
    return target
  } catch (error) {
    if (error instanceof L4WorkSessionProjectFileError) throw error
    throw new L4WorkSessionProjectFileError(
      'not-found',
      `Project path was not found: ${protocolPath}`
    )
  }
}

async function resolveExistingPreviewPath(root: string, path: string): Promise<string> {
  if (!isAbsolute(path)) return resolveExistingProjectPath(root, path)
  try {
    return await realpath(resolve(path))
  } catch {
    throw new L4WorkSessionProjectFileError('not-found', `Preview path was not found: ${path}`)
  }
}

async function resolveProjectFileRevealTarget(
  root: string,
  protocolPath: string
): Promise<ProjectFileRevealTarget> {
  const absolute = isAbsolute(protocolPath)
  const unresolved = resolve(root, protocolPath)
  if (!absolute && !isInsideRoot(root, unresolved)) {
    throw new L4WorkSessionProjectFileError(
      'outside-project',
      `Project path escapes root: ${protocolPath}`
    )
  }

  let directory: string
  try {
    directory = await realpath(dirname(unresolved))
  } catch {
    throw new L4WorkSessionProjectFileError(
      'not-found',
      `Containing directory was not found: ${protocolPath}`
    )
  }
  if (!absolute && !isInsideRoot(root, directory)) {
    throw new L4WorkSessionProjectFileError(
      'outside-project',
      `Containing directory resolves outside root: ${protocolPath}`
    )
  }
  if (!(await stat(directory)).isDirectory()) {
    throw new L4WorkSessionProjectFileError(
      'not-directory',
      `Containing path is not a directory: ${protocolPath}`
    )
  }

  let target: string
  try {
    target = await realpath(unresolved)
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return { target: unresolved, directory, exists: false }
    }
    throw new L4WorkSessionProjectFileError('read-failed', `无法读取定位目标：${protocolPath}`)
  }
  if (!absolute && !isInsideRoot(root, target)) {
    throw new L4WorkSessionProjectFileError(
      'outside-project',
      `Project path resolves outside root: ${protocolPath}`
    )
  }
  if (!(await stat(target)).isFile()) {
    throw new L4WorkSessionProjectFileError('not-file', `Target is not a file: ${protocolPath}`)
  }
  return { target, directory, exists: true }
}

function projectFileRevealInvocation(target: ProjectFileRevealTarget): {
  command: string
  args: string[]
} {
  if (process.platform === 'win32') {
    return target.exists
      ? { command: 'explorer.exe', args: ['/select,', target.target] }
      : { command: 'explorer.exe', args: [target.directory] }
  }
  if (process.platform === 'darwin') {
    return target.exists
      ? { command: 'open', args: ['-R', target.target] }
      : { command: 'open', args: [target.directory] }
  }
  return { command: 'xdg-open', args: [target.directory] }
}

async function runProjectFileRevealCommand(command: string, args: string[]): Promise<void> {
  await new Promise<void>((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    })
    const handleError = (error: Error): void => {
      child.off('spawn', handleSpawn)
      rejectRun(error)
    }
    const handleSpawn = (): void => {
      child.off('error', handleError)
      child.unref()
      resolveRun()
    }
    child.once('error', handleError)
    child.once('spawn', handleSpawn)
  })
}

export async function listL4WorkSessionProjectFiles(
  cwd: string,
  protocolPath: string
): Promise<L4WorkSessionProjectFileList> {
  const root = await resolveProjectRoot(cwd)
  const target = await resolveExistingProjectPath(root, protocolPath)
  let targetStat
  try {
    targetStat = await stat(target)
  } catch {
    throw new L4WorkSessionProjectFileError('not-found', `Directory was not found: ${protocolPath}`)
  }
  if (!targetStat.isDirectory()) {
    throw new L4WorkSessionProjectFileError(
      'not-directory',
      `Target is not a directory: ${protocolPath}`
    )
  }

  let dirents
  try {
    dirents = await readdir(target, { withFileTypes: true })
  } catch {
    throw new L4WorkSessionProjectFileError(
      'read-failed',
      `Directory cannot be read: ${protocolPath}`
    )
  }

  const entries = (
    await Promise.all(
      dirents.map(async (entry) => {
        if (IGNORED_NAMES.has(entry.name) || !isSupportedProtocolName(entry.name)) return null
        if (entry.isDirectory()) return { name: entry.name, type: 'directory' as const }
        if (entry.isFile()) return { name: entry.name, type: 'file' as const }
        if (!entry.isSymbolicLink()) return null

        try {
          const child = await realpath(resolve(target, entry.name))
          if (!isInsideRoot(root, child)) return null
          const childStat = await stat(child)
          if (childStat.isDirectory()) return { name: entry.name, type: 'directory' as const }
          if (childStat.isFile()) return { name: entry.name, type: 'file' as const }
          return null
        } catch {
          return null
        }
      })
    )
  )
    .filter((entry): entry is { name: string; type: 'directory' | 'file' } => entry !== null)
    .sort((left, right) => {
      if (left.type !== right.type) return left.type === 'directory' ? -1 : 1
      return left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: 'base' })
    })

  if (protocolPath === '') invalidateSearchIndex(root)
  return {
    entries: entries.slice(0, L4_PROJECT_FILE_LIST_MAX_ENTRIES),
    truncated: entries.length > L4_PROJECT_FILE_LIST_MAX_ENTRIES
  }
}

export async function revealL4WorkSessionProjectFile(
  cwd: string,
  protocolPath: string,
  run: ProjectFileRevealRunner = runProjectFileRevealCommand,
  targetType: 'file' | 'directory' = 'file'
): Promise<void> {
  const root = await resolveProjectRoot(cwd)
  let invocation: { command: string; args: string[] }
  if (targetType === 'directory') {
    const directory = await resolveExistingProjectPath(root, protocolPath)
    if (!(await stat(directory)).isDirectory()) {
      throw new L4WorkSessionProjectFileError('not-directory', '当前路径不是目录')
    }
    invocation = {
      command:
        process.platform === 'win32'
          ? 'explorer.exe'
          : process.platform === 'darwin'
            ? 'open'
            : 'xdg-open',
      args: [directory]
    }
  } else {
    const target = await resolveProjectFileRevealTarget(root, protocolPath)
    invocation = projectFileRevealInvocation(target)
  }
  try {
    await run(invocation.command, invocation.args)
  } catch {
    throw new L4WorkSessionProjectFileError(
      'reveal-failed',
      `Containing directory could not be opened: ${protocolPath}`
    )
  }
}

function detectSupportedImageMime(bytes: Buffer): L4ProjectFileImageMimeType | null {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'image/png'
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg'
  }
  if (bytes.length >= 6) {
    const header = bytes.toString('ascii', 0, 6)
    if (header === 'GIF87a' || header === 'GIF89a') return 'image/gif'
  }
  if (
    bytes.length >= 12 &&
    bytes.toString('ascii', 0, 4) === 'RIFF' &&
    bytes.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'image/webp'
  }
  return null
}

async function readHeader(path: string): Promise<Buffer> {
  const handle = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(16)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    return buffer.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}

async function imageResponse(
  bytes: Buffer,
  mimeType: L4ProjectFileImageMimeType,
  previewMode: L4ProjectFileImagePreviewMode
): Promise<L4WorkSessionProjectFileGet> {
  let metadata
  try {
    metadata = await sharp(bytes, {
      animated: mimeType === 'image/gif',
      limitInputPixels: L4_PROJECT_IMAGE_MAX_PIXELS
    }).metadata()
  } catch {
    throw new L4WorkSessionProjectFileError('unsupported', 'Image metadata is invalid')
  }

  const width = metadata.width ?? 0
  const height = metadata.height ?? 0
  if (width <= 0 || height <= 0 || width * height > L4_PROJECT_IMAGE_MAX_PIXELS) {
    throw new L4WorkSessionProjectFileError('image-too-large', 'Image dimensions exceed limit')
  }

  let output = bytes
  let outputMimeType = mimeType
  if (
    previewMode === 'compressed' &&
    mimeType !== 'image/gif' &&
    bytes.length > IMAGE_COMPRESSION_MIN_BYTES
  ) {
    try {
      const compressed = await sharp(bytes, {
        limitInputPixels: L4_PROJECT_IMAGE_MAX_PIXELS
      })
        .rotate()
        .resize({
          width: IMAGE_COMPRESSION_MAX_WIDTH,
          withoutEnlargement: true
        })
        .webp({ quality: 85, alphaQuality: 90, effort: 3, smartSubsample: true })
        .toBuffer()
      if (compressed.length <= bytes.length * (1 - IMAGE_COMPRESSION_MIN_SAVING_RATIO)) {
        output = compressed
        outputMimeType = 'image/webp'
      }
    } catch {
      // 压缩预览失败时回退原图，原文件仍可正常查看。
    }
  }

  return {
    kind: 'image',
    mimeType: outputMimeType,
    data: output.toString('base64'),
    size: output.length
  }
}

export async function getL4WorkSessionProjectFile(
  cwd: string,
  protocolPath: string,
  previewMode: L4ProjectFileImagePreviewMode
): Promise<L4WorkSessionProjectFileGet> {
  const root = await resolveProjectRoot(cwd)
  const target = await resolveExistingPreviewPath(root, protocolPath)
  let targetStat
  try {
    targetStat = await stat(target)
  } catch {
    throw new L4WorkSessionProjectFileError('not-found', `File was not found: ${protocolPath}`)
  }
  if (!targetStat.isFile()) {
    throw new L4WorkSessionProjectFileError('not-file', `Target is not a file: ${protocolPath}`)
  }

  if (targetStat.size > L4_PROJECT_IMAGE_FILE_MAX_BYTES) {
    const header = await readHeader(target)
    throw new L4WorkSessionProjectFileError(
      detectSupportedImageMime(header) ? 'image-too-large' : 'text-too-large',
      `File exceeds preview limit: ${protocolPath}`
    )
  }

  let bytes
  try {
    bytes = await readFile(target)
  } catch {
    throw new L4WorkSessionProjectFileError('read-failed', `File cannot be read: ${protocolPath}`)
  }
  if (bytes.length > L4_PROJECT_IMAGE_FILE_MAX_BYTES) {
    throw new L4WorkSessionProjectFileError(
      detectSupportedImageMime(bytes) ? 'image-too-large' : 'text-too-large',
      `File grew beyond limit: ${protocolPath}`
    )
  }

  const imageMime = detectSupportedImageMime(bytes)
  if (imageMime) return imageResponse(bytes, imageMime, previewMode)
  if (bytes.includes(0)) {
    throw new L4WorkSessionProjectFileError(
      'unsupported',
      `Binary file is unsupported: ${protocolPath}`
    )
  }

  let content: string
  try {
    content = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new L4WorkSessionProjectFileError(
      'unsupported',
      `File is not valid UTF-8: ${protocolPath}`
    )
  }
  if (bytes.length > L4_PROJECT_TEXT_FILE_MAX_BYTES) {
    throw new L4WorkSessionProjectFileError(
      'text-too-large',
      `Text file exceeds limit: ${protocolPath}`
    )
  }

  return {
    kind: 'text',
    content,
    size: bytes.length
  }
}
