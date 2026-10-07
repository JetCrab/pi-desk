import { z } from 'zod'
import { L4ProjectFilePathSchema } from '@common/l4_foundation/file/l4-project-file-contract'
import {
  L4GitHistoricalDiffSchema,
  L4GitOidSchema
} from '@common/l4_foundation/git/l4-git-history-contract'
import type { L4CodePreviewState } from '@client/l4_foundation/ui/code/l4-code-preview'

const GLOBAL_KEY = 'pi-super:project-preview:global'
const PROJECTS_KEY = 'pi-super:project-preview:projects'
const EXPIRES_AFTER_MS = 30 * 24 * 60 * 60 * 1000
const MAX_PROJECTS = 50

const panelSize = z.number().min(5).max(95)
const globalSchema = z.object({
  maximized: z.boolean(),
  directoryOpen: z.boolean(),
  gitOpen: z.boolean(),
  gitMaximized: z.boolean(),
  treeLayout: z.enum(['directory', 'repository']),
  directorySize: panelSize,
  gitSize: panelSize,
  logSize: panelSize,
  changeSize: panelSize
})
export type L2ProjectPreviewGlobal = z.infer<typeof globalSchema>
export const L2_PROJECT_PREVIEW_GLOBAL_DEFAULT: L2ProjectPreviewGlobal = {
  maximized: false,
  directoryOpen: true,
  gitOpen: false,
  gitMaximized: false,
  treeLayout: 'directory',
  directorySize: 22,
  gitSize: 45,
  logSize: 62,
  changeSize: 70
}

const historySchema = z.object({
  repositoryRoot: z.string().nullable(),
  mode: z.enum(['history', 'compare']),
  tip: z.string(),
  base: z.string(),
  target: z.string(),
  strategy: z.enum(['merge-base', 'direct']),
  query: z.string().max(200),
  author: z.string().max(200),
  selectedCommit: L4GitOidSchema.nullable(),
  selectedChangePath: L4ProjectFilePathSchema.nullable(),
  logScroll: z.number().nonnegative(),
  changesScroll: z.number().nonnegative()
})
const editorStateSchema = z.custom<L4CodePreviewState>(
  (value) =>
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as { cursorState?: unknown }).cursorState) &&
    typeof (value as { viewState?: unknown }).viewState === 'object'
)
const projectSchema = z.object({
  page: z.enum(['files', 'code', 'git']),
  historyPane: z.enum(['log', 'files']),
  tabs: z.array(L4ProjectFilePathSchema).max(20),
  activePath: L4ProjectFilePathSchema.nullable(),
  editorStates: z.record(L4ProjectFilePathSchema, editorStateSchema),
  fileViewModes: z.record(L4ProjectFilePathSchema, z.enum(['source', 'preview'])),
  expandedPaths: z.array(z.string()).max(500),
  treeScrollTop: z.number().nonnegative(),
  searchQuery: z.string().max(200),
  changesOnly: z.boolean(),
  expandedRepositories: z.array(z.string()).max(100),
  history: historySchema,
  activeDiff: z
    .object({
      repositoryRoot: z.string(),
      path: L4ProjectFilePathSchema,
      comparison: L4GitHistoricalDiffSchema.optional()
    })
    .nullable()
})
export type L2ProjectPreviewProject = z.infer<typeof projectSchema>
const entrySchema = z.object({ cwd: z.string(), lastOpenedAt: z.number(), state: projectSchema })
type Entry = z.infer<typeof entrySchema>

function keyForCwd(cwd: string): string {
  const path = cwd.replaceAll('\\', '/').replace(/\/+$/, '')
  return /^[a-z]:\//i.test(path) || path.startsWith('//') ? path.toLowerCase() : path
}

function readEntries(): Entry[] {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(PROJECTS_KEY) ?? '[]') as unknown
    if (!Array.isArray(parsed)) return []
    const now = Date.now()
    return parsed.flatMap((value) => {
      const result = entrySchema.safeParse(value)
      return result.success && now - result.data.lastOpenedAt < EXPIRES_AFTER_MS
        ? [result.data]
        : []
    })
  } catch {
    return []
  }
}

function writeEntries(entries: Entry[]): void {
  try {
    window.localStorage.setItem(
      PROJECTS_KEY,
      JSON.stringify(entries.sort((a, b) => b.lastOpenedAt - a.lastOpenedAt).slice(0, MAX_PROJECTS))
    )
  } catch (cause) {
    console.warn('[Pi Desk][ProjectPreview] 保存项目浏览状态失败', cause)
  }
}

export function loadL2ProjectPreviewGlobal(): L2ProjectPreviewGlobal {
  try {
    const value = JSON.parse(window.localStorage.getItem(GLOBAL_KEY) ?? 'null') as unknown
    return { ...L2_PROJECT_PREVIEW_GLOBAL_DEFAULT, ...globalSchema.partial().parse(value) }
  } catch {
    return { ...L2_PROJECT_PREVIEW_GLOBAL_DEFAULT }
  }
}

export function saveL2ProjectPreviewGlobal(value: L2ProjectPreviewGlobal): void {
  try {
    window.localStorage.setItem(GLOBAL_KEY, JSON.stringify(value))
  } catch (cause) {
    console.warn('[Pi Desk][ProjectPreview] 保存全局布局失败', cause)
  }
}

export function openL2ProjectPreviewProject(cwd: string): L2ProjectPreviewProject | null {
  const key = keyForCwd(cwd)
  const entries = readEntries()
  const found = entries.find((entry) => entry.cwd === key)
  // 仅打开时更新有效期；普通操作不会让未打开的项目永久保留。
  if (found) found.lastOpenedAt = Date.now()
  writeEntries(entries)
  return found?.state ?? null
}

export function saveL2ProjectPreviewProject(cwd: string, state: L2ProjectPreviewProject): void {
  const parsed = projectSchema.safeParse(state)
  if (!parsed.success) return
  const key = keyForCwd(cwd)
  const entries = readEntries()
  const existing = entries.find((entry) => entry.cwd === key)
  if (existing) existing.state = parsed.data
  else entries.push({ cwd: key, lastOpenedAt: Date.now(), state: parsed.data })
  writeEntries(entries)
}
