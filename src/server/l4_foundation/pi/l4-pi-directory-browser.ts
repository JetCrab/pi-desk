import 'server-only'

import { readdir, stat } from 'node:fs/promises'
import { statSync } from 'node:fs'
import { dirname, join, parse, resolve } from 'node:path'
import { getL4PiDirectoryKey, listL4IgnoredPiDirectoryCwds } from './l4-pi-directory-ignore-store'

export interface L4PiDirectoryEntry {
  cwd: string
  name: string
}

export interface L4PiDirectoryEntryList {
  cwd: string | null
  parentCwd: string | null
  directories: L4PiDirectoryEntry[]
}

class L4PiDirectoryInvalidError extends Error {
  constructor(cwd: string) {
    super(`Pi project directory is invalid: ${cwd}`)
    this.name = 'L4PiDirectoryInvalidError'
  }
}

class L4PiDirectoryReadError extends Error {
  constructor(cwd: string) {
    super(`Pi project directory cannot be read: ${cwd}`)
    this.name = 'L4PiDirectoryReadError'
  }
}

export function isL4PiDirectoryInvalidError(error: unknown): boolean {
  return error instanceof Error && error.name === 'L4PiDirectoryInvalidError'
}

export function isL4PiDirectoryReadError(error: unknown): boolean {
  return error instanceof Error && error.name === 'L4PiDirectoryReadError'
}

export function resolveL4ExistingPiDirectory(cwdInput: string): string {
  const cwd = resolve(cwdInput)
  try {
    if (!statSync(cwd).isDirectory()) throw new L4PiDirectoryInvalidError(cwd)
  } catch (error) {
    if (error instanceof L4PiDirectoryInvalidError) throw error
    throw new L4PiDirectoryInvalidError(cwd)
  }
  return cwd
}

function ignoredDirectoryKeys(): Set<string> {
  return new Set(listL4IgnoredPiDirectoryCwds().map(getL4PiDirectoryKey))
}

function windowsRoots(): L4PiDirectoryEntry[] {
  const roots: L4PiDirectoryEntry[] = []
  for (let code = 65; code <= 90; code += 1) {
    const cwd = `${String.fromCharCode(code)}:\\`
    try {
      if (statSync(cwd).isDirectory()) roots.push({ cwd, name: cwd })
    } catch {
      // 未挂载的盘符不是错误。
    }
  }
  return roots
}

function rootDirectories(): L4PiDirectoryEntryList {
  const root = parse(process.cwd()).root
  const directories = process.platform === 'win32' ? windowsRoots() : [{ cwd: root, name: root }]
  const ignored = ignoredDirectoryKeys()

  return {
    cwd: null,
    parentCwd: null,
    directories: directories.filter((item) => !ignored.has(getL4PiDirectoryKey(item.cwd)))
  }
}

async function isDirectoryEntry(
  parentCwd: string,
  name: string,
  directory: boolean,
  symbolicLink: boolean
): Promise<boolean> {
  if (directory) return true
  if (!symbolicLink) return false
  try {
    return (await stat(join(parentCwd, name))).isDirectory()
  } catch {
    return false
  }
}

export async function listL4PiDirectoryEntries(
  cwdInput: string | null
): Promise<L4PiDirectoryEntryList> {
  if (cwdInput === null) return rootDirectories()

  const cwd = resolveL4ExistingPiDirectory(cwdInput)
  let entries
  try {
    entries = await readdir(cwd, { withFileTypes: true })
  } catch {
    throw new L4PiDirectoryReadError(cwd)
  }

  const ignored = ignoredDirectoryKeys()
  const directories = (
    await Promise.all(
      entries.map(async (entry): Promise<L4PiDirectoryEntry | null> => {
        if (
          !(await isDirectoryEntry(cwd, entry.name, entry.isDirectory(), entry.isSymbolicLink()))
        ) {
          return null
        }
        const childCwd = resolve(cwd, entry.name)
        if (ignored.has(getL4PiDirectoryKey(childCwd))) return null
        return { cwd: childCwd, name: entry.name }
      })
    )
  )
    .filter((entry): entry is L4PiDirectoryEntry => entry !== null)
    .sort((left, right) =>
      left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: 'base' })
    )

  const root = parse(cwd).root
  return {
    cwd,
    parentCwd: getL4PiDirectoryKey(cwd) === getL4PiDirectoryKey(root) ? null : dirname(cwd),
    directories
  }
}
