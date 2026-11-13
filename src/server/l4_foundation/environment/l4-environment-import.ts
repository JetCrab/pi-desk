import { createHash } from 'node:crypto'
import { bindConfigStore } from '@jetcrab/pi-desk-sdk/config'
import {
  importL4UnifiedConfigSecrets,
  isL4EnvironmentUnifiedConfig
} from './l4-environment-unified-config'
import { createReadStream, createWriteStream } from 'node:fs'
import { lstat, mkdir, readFile, stat } from 'node:fs/promises'
import { dirname, join, posix, relative, win32 } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { createSecretStore, type SecretStore } from '@jetcrab/pi-desk-sdk/secrets'
import {
  L4ReadAuthConfigSchema,
  restoreL4AuthSessionKey
} from '@server/l4_foundation/auth/l4-auth-storage'
import type { L4EnvironmentSelection, L4EnvironmentPreviewSummary } from './l4-environment-state'
import type {
  L4EnvironmentEntryConsumer,
  L4EnvironmentEntryReader,
  L4EnvironmentPreviewCache
} from './l4-environment-preview-cache'
import {
  canL4EnvironmentDesktop,
  isL4EnvironmentDesktopOwnerFile,
  L4_ENVIRONMENT_DESKTOP_OWNER_FILES,
  exportL4EnvironmentDesktop,
  encodeL4EnvironmentDesktopStage,
  L4EnvironmentDesktopPortableSchema,
  L4_ENVIRONMENT_DESKTOP_MAX_BYTES,
  stageL4EnvironmentDesktop
} from './l4-environment-desktop'
import { L4EnvironmentValidationError } from './l4-environment-error'
import { readEnvironmentArchive } from './l4-environment-archive'
import {
  assertEnvironmentEntryPath,
  assertEnvironmentTargetPaths,
  currentEnvironmentTargetSemantics,
  environmentTargetNameKey,
  environmentTargetPathKey,
  environmentPathKey,
  mapEnvironmentPath,
  type EnvironmentPathMapping
} from './l4-environment-paths'
import {
  L4EnvironmentManifestSchema,
  L4EnvironmentWorkStateSchema,
  type L4EnvironmentFile,
  type L4EnvironmentManifest
} from './l4-environment-manifest'
import {
  linesL4Environment,
  readL4EnvironmentBounded,
  walkL4Environment
} from './l4-environment-collect'
import {
  collectL4EnvironmentSecretReferences,
  readL4EnvironmentStructured,
  transformL4EnvironmentConfig
} from './l4-environment-config'
import {
  isL4EnvironmentMachinePath,
  isL4EnvironmentSessionStoragePath,
  isL4EnvironmentRootConfiguration,
  l4EnvironmentSessionSuffix
} from './l4-environment-files'
import { convertEnvironmentSessionLine } from './l4-environment-sessions'
import {
  applyL4EnvironmentTransaction,
  assertL4EnvironmentTarget,
  writeL4EnvironmentJson
} from './l4-environment-maintenance'

export interface L4EnvironmentPreview {
  manifest: L4EnvironmentManifest
  summary: L4EnvironmentPreviewSummary
}

function validateManifest(manifest: L4EnvironmentManifest): void {
  const ids = new Set<string>()
  const entries: string[] = ['manifest.json']
  for (const file of manifest.files) {
    if (ids.has(file.id)) throw new Error('归档包含重复选择项')
    ids.add(file.id)
    assertEnvironmentEntryPath(file.entry)
    assertEnvironmentEntryPath(file.path)
    if (
      file.base === 'agent' &&
      L4_ENVIRONMENT_DESKTOP_OWNER_FILES.some((name) => file.path === `config/${name}`)
    )
      throw new Error('Rust Owner文件不能作为普通配置恢复')
    if (file.category !== 'session' && file.children.length)
      throw new Error('非会话项不能隐式包含其他选择项')
    if (file.secretPaths.length && !file.secretEntry)
      throw new Error('敏感字段声明缺少加密秘密条目')
    if (isL4EnvironmentMachinePath(file.path)) throw new Error('归档包含禁止恢复的机器状态')
    if (
      file.base === 'agent' &&
      !/^(?:config\/|skills\/|agents\/|prompts\/|themes\/|extensions\/|sessions\/|pi-desk\/)/.test(
        file.path
      ) &&
      !isL4EnvironmentRootConfiguration(file.path)
    )
      throw new Error('归档包含未知宿主根文件')
    if (
      file.base === 'desktop' &&
      (file.path !== 'desktop.portable.json' ||
        file.category !== 'config' ||
        file.format !== 'binary' ||
        file.secretEntry !== null)
    )
      throw new Error('桌面配置必须使用native portable项')
    if (file.base === 'resource' && !file.path.startsWith('resources/'))
      throw new Error('外部资源清单路径无效')
    if (
      file.category === 'session' &&
      (!file.path.startsWith('sessions/') ||
        file.base !== 'agent' ||
        !file.sessionId ||
        !file.sourceCwd)
    )
      throw new Error('归档会话声明无效')
    if (
      file.category !== 'session' &&
      (file.path.startsWith('sessions/') || file.path === 'pi-desk/work-sessions.json')
    )
      throw new Error('会话状态不能作为普通配置恢复')
    if (
      file.category === 'plugin-data' &&
      (!file.path.startsWith('pi-desk/') || file.base !== 'agent')
    )
      throw new Error('插件数据声明无效')
    entries.push(file.entry)
    if (file.secretEntry) {
      assertEnvironmentEntryPath(file.secretEntry)
      entries.push(file.secretEntry)
    }
  }
  const syntax = process.platform === 'win32' ? 'win32' : 'posix'
  assertEnvironmentTargetPaths(entries, syntax, currentEnvironmentTargetSemantics(syntax))
}

export function groupL4EnvironmentFiles(
  manifest: L4EnvironmentManifest
): Map<string, L4EnvironmentFile[]> {
  const groups = new Map<string, L4EnvironmentFile[]>()
  const sourcePlatform = manifest.sourcePlatform === 'win32' ? 'win32' : 'posix'
  const sessionsByPath = new Map(
    manifest.files
      .filter((file) => file.category === 'session')
      .map((file) => [environmentPathKey(file.sourcePath, sourcePlatform), file])
  )
  const referenced = new Set(
    manifest.files
      .filter((file) => file.category === 'session')
      .flatMap((file) => file.children.map((child) => environmentPathKey(child, sourcePlatform)))
  )
  const covered = new Set<string>()
  function add(root: L4EnvironmentFile): void {
    const members: L4EnvironmentFile[] = []
    const visited = new Set<string>()
    function visit(file: L4EnvironmentFile): void {
      if (visited.has(file.id)) return
      visited.add(file.id)
      covered.add(file.id)
      members.push(file)
      for (const child of file.children) {
        const found = sessionsByPath.get(environmentPathKey(child, sourcePlatform))
        if (found) visit(found)
      }
    }
    visit(root)
    groups.set(root.id, members)
  }
  for (const file of manifest.files)
    if (!referenced.has(environmentPathKey(file.sourcePath, sourcePlatform))) add(file)
  for (const file of manifest.files) if (!covered.has(file.id)) add(file)
  return groups
}

export async function inspectL4EnvironmentArchive(input: {
  id: string
  archivePath: string
  password: string
  cache?: L4EnvironmentPreviewCache
}): Promise<L4EnvironmentPreview> {
  let manifest: L4EnvironmentManifest | null = null
  const seen = new Set<string>()
  const sizes = new Map<string, number>()
  const expectedSecrets = new Map<string, string[]>()
  const archiveSecrets = new Map<string, string[]>()
  const entries = new Map<string, L4EnvironmentFile>()
  const consume: L4EnvironmentEntryConsumer = async (header, content): Promise<void> => {
    seen.add(header.path)
    if (header.path === 'manifest.json') {
      manifest = L4EnvironmentManifestSchema.parse(
        JSON.parse((await readL4EnvironmentBounded(content)).toString('utf8'))
      )
      validateManifest(manifest)
      for (const file of manifest.files) {
        entries.set(file.entry, file)
        if (file.secretEntry) entries.set(file.secretEntry, file)
      }
      return
    }
    if (!manifest) throw new Error('归档必须先提供清单')
    const file = entries.get(header.path)
    if (!file) throw new Error('归档含清单外文件')
    sizes.set(header.path, header.size)
    if (file.base === 'desktop') {
      const portable = L4EnvironmentDesktopPortableSchema.parse(
        JSON.parse(
          (await readL4EnvironmentBounded(content, L4_ENVIRONMENT_DESKTOP_MAX_BYTES)).toString(
            'utf8'
          )
        )
      )
      const nativePlatform = { windows: 'win32', macos: 'darwin', linux: 'linux' } as const
      if (nativePlatform[portable.sourcePlatform] !== manifest.sourcePlatform)
        throw new Error('桌面源平台与环境清单不一致')
    } else if (file.secretEntry === header.path) {
      const values: unknown = JSON.parse((await readL4EnvironmentBounded(content)).toString('utf8'))
      if (
        values === null ||
        typeof values !== 'object' ||
        Array.isArray(values) ||
        Object.entries(values).some(
          ([ref, value]) => !/^secret:\/\/[0-9a-f-]{36}$/i.test(ref) || typeof value !== 'string'
        )
      )
        throw new Error('归档凭据条目无效')
      archiveSecrets.set(file.id, Object.keys(values))
    } else if (file.category === 'session') {
      let first = true
      for await (const line of linesL4Environment(content)) {
        if (!line.text.trim()) continue
        if (first) {
          const header = JSON.parse(line.text) as { type?: string; id?: string; cwd?: string }
          if (
            header.type !== 'session' ||
            header.id !== file.sessionId ||
            header.cwd !== file.sourceCwd
          )
            throw new Error('归档会话头与清单不一致')
          first = false
        }
        const parsed: unknown = JSON.parse(line.text)
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
          throw new Error('归档会话条目无效')
      }
      if (first) throw new Error('归档会话为空')
    } else if (file.format !== 'binary') {
      const data = await readL4EnvironmentBounded(content)
      transformL4EnvironmentConfig({ content: data, file, requireSecretReferences: true })
      expectedSecrets.set(
        file.id,
        collectL4EnvironmentSecretReferences(
          readL4EnvironmentStructured(data, file.format),
          file.secretPaths
        )
      )
    }
  }
  await readEnvironmentArchive({
    archivePath: input.archivePath,
    password: input.password,
    consumeEntry: (header, content) =>
      input.cache ? input.cache.capture(header, content, consume) : consume(header, content)
  })
  if (!manifest) throw new Error('归档缺少清单')
  const valid = manifest as L4EnvironmentManifest
  for (const file of valid.files) {
    if (!seen.has(file.entry) || (file.secretEntry && !seen.has(file.secretEntry)))
      throw new Error('归档缺少清单文件')
    if (file.secretEntry) {
      const expected = new Set(expectedSecrets.get(file.id) ?? [])
      const actual = archiveSecrets.get(file.id) ?? []
      if (expected.size !== actual.length || actual.some((reference) => !expected.has(reference)))
        throw new Error('秘密条目与声明敏感字段不一致')
    }
  }
  return {
    manifest: valid,
    summary: {
      id: input.id,
      sourcePlatform: valid.sourcePlatform,
      warnings: valid.warnings,
      items: [...groupL4EnvironmentFiles(valid)].map(([id, members]) => {
        const file = members[0]!
        return {
          id,
          title: file.title,
          category: file.category,
          files: members.length,
          bytes: members.reduce((sum, member) => sum + (sizes.get(member.entry) ?? 0), 0),
          sourceCwd: file.sourceCwd,
          sessionId: file.sessionId,
          mappingSources: [
            ...new Set(
              members.flatMap((member) => [
                ...member.mappingSources,
                ...(member.sourceCwd && member.sourceCwd !== file.sourceCwd
                  ? [member.sourceCwd]
                  : [])
              ])
            )
          ],
          conflicts: [],
          warnings: [...new Set(members.flatMap((member) => member.warnings))]
        }
      })
    }
  }
}

interface PlannedFile {
  file: L4EnvironmentFile
  target: string
  skip: boolean
  hash: string
}
export interface L4EnvironmentImportPlan {
  files: PlannedFile[]
  mappings: EnvironmentPathMapping[]
  sessionFileMappings: EnvironmentPathMapping[]
  workSessions: { workId: string; cwd: string; sessionId: string }[]
  pinnedCount: number
  warnings: string[]
}

function relativeEnvironmentTarget(agentDir: string, target: string): string {
  return relative(agentDir, target).split(win32.sep).join('/')
}

function platform(manifest: L4EnvironmentManifest): 'win32' | 'posix' {
  return manifest.sourcePlatform === 'win32' ? 'win32' : 'posix'
}

async function* transformedSession(
  content: AsyncIterable<Uint8Array>,
  file: L4EnvironmentFile,
  target: string,
  manifest: L4EnvironmentManifest,
  plan: Pick<L4EnvironmentImportPlan, 'mappings' | 'sessionFileMappings'>
): AsyncGenerator<Buffer> {
  for await (const line of linesL4Environment(content)) {
    const result = convertEnvironmentSessionLine(line.text, {
      sourcePlatform: platform(manifest),
      targetPlatform: process.platform === 'win32' ? 'win32' : 'posix',
      sourceSessionFile: file.sourcePath,
      targetSessionFile: target,
      projectMappings: plan.mappings,
      sessionFileMappings: plan.sessionFileMappings
    })
    if (result.missingReferences.some((reference) => reference.kind === 'project'))
      throw new Error('会话项目缺少路径映射')
    yield Buffer.from(result.line + line.ending)
  }
}

async function hashFile(path: string): Promise<string | null> {
  const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (!info) return null
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('恢复目标不是普通文件')
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

export async function planL4EnvironmentImport(input: {
  agentDir: string
  archivePath: string
  password: string
  manifest: L4EnvironmentManifest
  selection: L4EnvironmentSelection
  readEntries?: L4EnvironmentEntryReader
  previewConflicts?: Map<string, string[]>
}): Promise<L4EnvironmentImportPlan> {
  const { manifest, selection } = input
  const targetPlatform = process.platform === 'win32' ? 'win32' : 'posix'
  const targetSemantics = currentEnvironmentTargetSemantics(targetPlatform)
  const sourceApi = platform(manifest) === 'win32' ? win32 : posix
  const mappings = selection.mappings.map(({ from, to }) => ({ source: from, target: to }))
  if (
    !mappings.some(
      (mapping) =>
        environmentPathKey(mapping.source, platform(manifest)) ===
        environmentPathKey(manifest.sourceAgentDir, platform(manifest))
    )
  )
    mappings.push({ source: manifest.sourceAgentDir, target: input.agentDir })
  const selected = new Set(selection.selectedIds)
  const groups = groupL4EnvironmentFiles(manifest)
  if (selected.size !== selection.selectedIds.length || [...selected].some((id) => !groups.has(id)))
    throw new L4EnvironmentValidationError('导入选择项不是预览中的独立根组')
  const filesById = new Map(manifest.files.map((file) => [file.id, file]))
  const sessionsByPath = new Map(
    manifest.files
      .filter((file) => file.category === 'session')
      .map((file) => [environmentPathKey(file.sourcePath, platform(manifest)), file])
  )
  const includeChildren = (id: string): void => {
    const file = filesById.get(id)!
    for (const child of file.children) {
      const found = sessionsByPath.get(environmentPathKey(child, platform(manifest)))
      if (found && !selected.has(found.id)) {
        selected.add(found.id)
        includeChildren(found.id)
      }
    }
  }
  for (const id of selected) includeChildren(id)
  const existingSessions = new Map<string, { path: string; cwd: string }[]>()
  if (manifest.files.some((file) => selected.has(file.id) && file.category === 'session')) {
    for await (const path of walkL4Environment(join(input.agentDir, 'sessions'))) {
      if (!path.endsWith('.jsonl')) continue
      const stream = createReadStream(path)
      try {
        for await (const line of linesL4Environment(stream)) {
          if (!line.text.trim()) continue
          const header = JSON.parse(line.text) as { type?: string; id?: string; cwd?: string }
          if (header.type === 'session' && header.id && header.cwd)
            existingSessions.set(header.id, [
              ...(existingSessions.get(header.id) ?? []),
              { path, cwd: header.cwd }
            ])
          break
        }
      } finally {
        stream.destroy()
      }
    }
  }
  const files: PlannedFile[] = []
  const mappingTargets = new Map<string, boolean>()
  function conflict(file: L4EnvironmentFile, message: string): void {
    if (!input.previewConflicts) throw new L4EnvironmentValidationError(message)
    const previous = input.previewConflicts.get(file.id) ?? []
    input.previewConflicts.set(file.id, [...new Set([...previous, message])])
  }
  async function mappedDirectory(source: string): Promise<string> {
    const mapped =
      mapEnvironmentPath(source, mappings, platform(manifest), targetPlatform) ??
      (platform(manifest) === targetPlatform ? source : null)
    if (!mapped) throw new Error('项目路径缺少目标映射')
    if (
      !(await stat(mapped).then(
        (info) => info.isDirectory(),
        () => false
      ))
    )
      throw new Error('映射目标项目目录不存在')
    return mapped
  }
  for (const file of manifest.files.filter((file) => selected.has(file.id))) {
    try {
      const sources = [...file.mappingSources, ...(file.sourceCwd ? [file.sourceCwd] : [])]
      for (const mapping of selection.mappings) {
        if (
          !sources.some(
            (source) =>
              mapEnvironmentPath(
                source,
                [{ source: mapping.from, target: mapping.to }],
                platform(manifest),
                targetPlatform
              ) !== null
          )
        )
          continue
        if (!mappingTargets.has(mapping.to))
          mappingTargets.set(
            mapping.to,
            await stat(mapping.to).then(
              (info) => info.isDirectory(),
              () => false
            )
          )
        if (!mappingTargets.get(mapping.to)) throw new Error('映射目标目录不存在')
      }
      let target: string
      if (file.category === 'session') {
        const cwd = await mappedDirectory(file.sourceCwd!)
        const key = `--${cwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`
        const existing = existingSessions.get(file.sessionId!) ?? []
        if (
          existing.length > 1 ||
          existing.some(
            (session) =>
              environmentTargetPathKey(session.cwd, targetPlatform, targetSemantics) !==
              environmentTargetPathKey(cwd, targetPlatform, targetSemantics)
          )
        ) {
          conflict(file, '目标环境已有相同 Pi ID 的重复文件或不同项目绑定')
          continue
        }
        const suffix = l4EnvironmentSessionSuffix(file.sourcePath)
        const parent = manifest.files.find(
          (candidate) =>
            candidate.category === 'session' &&
            candidate.children.some(
              (child) =>
                environmentPathKey(child, platform(manifest)) ===
                environmentPathKey(file.sourcePath, platform(manifest))
            )
        )
        const location =
          suffix ??
          (parent
            ? `subagents/${parent.sessionId}/${sourceApi.basename(file.sourcePath)}`
            : sourceApi.basename(file.sourcePath))
        if (existing[0] && (suffix || parent) && !l4EnvironmentSessionSuffix(existing[0].path)) {
          conflict(file, '同一子代理Pi会话已位于主历史目录，请先解决位置冲突')
          continue
        }
        target = existing[0]?.path ?? join(input.agentDir, 'sessions', key, location)
      } else if (file.base === 'desktop') {
        if (!canL4EnvironmentDesktop(input.agentDir)) {
          conflict(file, '当前桌面未声明portable恢复能力，不能导入此项')
          continue
        }
        const pending = await Promise.all(
          ['desktop-environment.pending.json', 'desktop-environment.transaction.json'].map((name) =>
            stat(join(input.agentDir, 'config', name)).then(
              () => true,
              () => false
            )
          )
        )
        if (pending.some(Boolean)) {
          conflict(file, '桌面已有待恢复请求或未完成事务，不能重复导入')
          continue
        }
        target = join(input.agentDir, 'config', 'desktop.json')
      } else if (file.base === 'resource') {
        const mapped = mapEnvironmentPath(
          file.sourcePath,
          mappings,
          platform(manifest),
          targetPlatform
        )
        if (!mapped) throw new Error('外部资源缺少目标映射')
        target = mapped
      } else if (file.base === 'project') {
        target = join(await mappedDirectory(file.sourceCwd!), '.pi', file.path)
      } else target = join(input.agentDir, file.path)
      if (
        file.category !== 'session' &&
        isL4EnvironmentSessionStoragePath(relativeEnvironmentTarget(input.agentDir, target))
      )
        throw new Error('普通配置或资源不能覆盖核心会话存储')
      if (
        file.base !== 'desktop' &&
        isL4EnvironmentMachinePath(relativeEnvironmentTarget(input.agentDir, target))
      )
        throw new Error('普通项不能覆盖机器状态或缓存')
      if (file.base !== 'desktop' && isL4EnvironmentDesktopOwnerFile(input.agentDir, target))
        throw new Error('普通项不能映射覆盖Rust Owner文件')
      const targetApi = targetPlatform === 'win32' ? win32 : posix
      assertEnvironmentTargetPaths(
        [targetApi.relative(targetApi.parse(target).root, target).split(targetApi.sep).join('/')],
        targetPlatform,
        targetSemantics
      )
      await assertL4EnvironmentTarget(target)
      files.push({ file, target, skip: false, hash: '' })
    } catch (error) {
      if (error instanceof L4EnvironmentValidationError) throw error
      conflict(file, '恢复目标路径无效、映射缺失、目录不存在或包含符号链接')
    }
  }
  const targetOwners = new Map<string, { spelling: string; file: boolean; ids: Set<string> }>()
  const targetApi = targetPlatform === 'win32' ? win32 : posix
  for (const planned of files) {
    const root = targetApi.parse(planned.target).root
    const parts = targetApi.relative(root, planned.target).split(targetApi.sep)
    for (let index = 0; index < parts.length; index += 1) {
      const spelling = parts.slice(0, index + 1).join('/')
      const key = `${environmentTargetNameKey(root, targetSemantics)}\0${environmentTargetNameKey(spelling, targetSemantics)}`
      const leaf = index === parts.length - 1
      const previous = targetOwners.get(key)
      if (previous) {
        if (previous.spelling !== spelling || previous.file || leaf) {
          for (const id of previous.ids)
            conflict(filesById.get(id)!, '映射目标存在重复、大小写、规范等价或文件目录冲突')
          conflict(planned.file, '映射目标存在重复、大小写、规范等价或文件目录冲突')
        }
        previous.ids.add(planned.file.id)
        previous.file ||= leaf
      } else targetOwners.set(key, { spelling, file: leaf, ids: new Set([planned.file.id]) })
    }
  }
  const plan: L4EnvironmentImportPlan = {
    files,
    mappings,
    sessionFileMappings: files
      .filter(({ file }) => file.category === 'session')
      .map(({ file, target }) => ({ source: file.sourcePath, target })),
    workSessions: [],
    pinnedCount: 0,
    warnings: []
  }
  // 同平台未改路径也显式加入映射，避免把 Windows 路径交给 POSIX resolve。
  for (const { file } of files) {
    if (
      file.sourceCwd &&
      !mappings.some(
        (mapping) =>
          mapEnvironmentPath(file.sourceCwd!, [mapping], platform(manifest), targetPlatform) !==
          null
      )
    ) {
      mappings.push({ source: file.sourceCwd, target: await mappedDirectory(file.sourceCwd) })
    }
  }
  const plannedEntries = new Map(files.map((planned) => [planned.file.entry, planned]))
  const consume: L4EnvironmentEntryConsumer = async (header, content): Promise<void> => {
    const planned = plannedEntries.get(header.path)
    if (!planned) return
    try {
      const hash = createHash('sha256')
      let regeneratesReferences = false
      if (planned.file.base === 'desktop') {
        const portable = await readL4EnvironmentBounded(content, L4_ENVIRONMENT_DESKTOP_MAX_BYTES)
        encodeL4EnvironmentDesktopStage(selection.id, portable)
        hash.update(portable)
      } else if (planned.file.category === 'session') {
        for await (const chunk of transformedSession(
          content,
          planned.file,
          planned.target,
          manifest,
          plan
        ))
          hash.update(chunk)
      } else if (planned.file.format !== 'binary') {
        const transformed = transformL4EnvironmentConfig({
          content: await readL4EnvironmentBounded(content),
          file: planned.file,
          mappings,
          sourcePlatform: platform(manifest),
          targetPlatform
        })
        regeneratesReferences = Boolean(
          planned.file.secretEntry &&
          collectL4EnvironmentSecretReferences(
            readL4EnvironmentStructured(transformed, planned.file.format),
            planned.file.secretPaths
          ).length
        )
        if (planned.file.base === 'agent' && planned.file.path === 'config/pi-desk.yaml') {
          const root = readL4EnvironmentStructured(transformed, 'yaml') as Record<string, unknown>
          const host = root['pi-desk'] as Record<string, unknown> | undefined
          const auth = host?.auth
          if (
            auth &&
            typeof auth === 'object' &&
            Object.keys(auth).length &&
            !L4ReadAuthConfigSchema.safeParse(auth).success
          ) {
            throw new L4EnvironmentValidationError('宿主登录配置格式无效，未修改目标环境')
          }
        }
        hash.update(transformed)
      } else for await (const chunk of content) hash.update(chunk)
      planned.hash = hash.digest('hex')
      const existing =
        planned.file.base === 'desktop'
          ? await stat(planned.target).then(
              async () =>
                createHash('sha256')
                  .update(await exportL4EnvironmentDesktop(input.agentDir))
                  .digest('hex'),
              () => null
            )
          : await hashFile(planned.target)
      if (existing && regeneratesReferences && !selection.overwrite)
        conflict(planned.file, '目标文件已有凭据配置，导入会生成本机新引用；请明确确认覆盖所选文件')
      if (existing === planned.hash) {
        if (planned.file.category === 'session') planned.skip = true
      } else if (existing && (planned.file.category === 'session' || !selection.overwrite))
        conflict(planned.file, '恢复目标已有不同内容，必须解决冲突或明确允许配置覆盖')
    } catch (error) {
      if (error instanceof L4EnvironmentValidationError) throw error
      conflict(planned.file, '所选配置或会话的本地路径尚未映射，或目标内容不可读取')
    }
  }
  if (input.readEntries) await input.readEntries(consume)
  else
    await readEnvironmentArchive({
      archivePath: input.archivePath,
      password: input.password,
      consumeEntry: consume
    })
  const sessionFiles = files.filter(({ file }) => file.category === 'session')
  for (const binding of manifest.workSessions) {
    const session = sessionFiles.find(
      ({ file }) => file.sessionId === binding.sessionId && file.sourceCwd === binding.cwd
    )
    if (session) plan.workSessions.push({ ...binding, cwd: await mappedDirectory(binding.cwd) })
  }
  const sourcePinnedSessions = new Set(
    manifest.workSessions.slice(0, manifest.pinnedCount).map((binding) => binding.sessionId)
  )
  plan.pinnedCount = plan.workSessions.filter((binding) =>
    sourcePinnedSessions.has(binding.sessionId)
  ).length
  if (plan.workSessions.length) {
    try {
      await mergedWorkSessions(input.agentDir, plan.workSessions, plan.pinnedCount)
    } catch {
      for (const session of sessionFiles)
        conflict(session.file, '工作会话绑定冲突，不能覆盖目标会话集合')
    }
  }
  if (
    files.some(({ file }) =>
      file.children.some(
        (child) => !plan.sessionFileMappings.some((mapping) => mapping.source === child)
      )
    )
  )
    plan.warnings.push('包外会话引用保留原值；外部文件和工作区不会恢复。')
  return plan
}

async function mergedWorkSessions(
  agentDir: string,
  imported: L4EnvironmentImportPlan['workSessions'],
  pinnedCount: number
): Promise<{ workSessions: L4EnvironmentImportPlan['workSessions']; pinnedCount: number }> {
  const raw = await readFile(join(agentDir, 'pi-desk', 'work-sessions.json'), 'utf8').catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null
      throw error
    }
  )
  const state = raw
    ? L4EnvironmentWorkStateSchema.parse(JSON.parse(raw))
    : { workSessions: [], pinnedCount: 0 }
  const empty = state.workSessions.length === 0
  for (const binding of imported) {
    const sameSession = state.workSessions.find((item) => item.sessionId === binding.sessionId)
    if (sameSession) {
      if (
        environmentTargetPathKey(
          sameSession.cwd,
          process.platform === 'win32' ? 'win32' : 'posix'
        ) !==
        environmentTargetPathKey(binding.cwd, process.platform === 'win32' ? 'win32' : 'posix')
      )
        throw new Error('同一Pi会话已绑定不同项目')
      continue
    }
    if (state.workSessions.some((item) => item.workId === binding.workId))
      throw new Error('工作会话展示ID已用于其他Pi会话')
    state.workSessions.push(binding)
  }
  if (empty) state.pinnedCount = pinnedCount
  return state
}

export async function applyL4EnvironmentImport(input: {
  directory: string
  agentDir: string
  archivePath: string
  password: string
  manifest: L4EnvironmentManifest
  selection: L4EnvironmentSelection
  targetStore?: SecretStore
  rollbackStore?: SecretStore
}): Promise<string[]> {
  const plan = await planL4EnvironmentImport(input)
  const targetStore = input.targetStore ?? createSecretStore({ agentDir: input.agentDir })
  const selected = plan.files.filter((file) => !file.skip)
  const hostFiles = selected.filter(({ file }) => file.base !== 'desktop')
  const hostEntries = new Map(hostFiles.map((planned) => [planned.file.entry, planned]))
  let desktopContent: Buffer | undefined
  const importedRefs: Record<string, string> = {}
  // 已认证包中的逻辑秘密仅驻留内存，按当前SecretStore合同生成目标引用。
  const archiveSecrets: Record<string, string> = {}
  const inlineSecrets: Record<string, string> = {}
  const globalConfig = selected.find(
    ({ file }) => file.base === 'agent' && file.path === 'config/pi-desk.yaml'
  )
  let restoresAuth = false
  if (globalConfig || selected.some(({ file }) => file.secretEntry || file.base === 'desktop')) {
    await readEnvironmentArchive({
      archivePath: input.archivePath,
      password: input.password,
      async consumeEntry(header, content): Promise<void> {
        if (globalConfig?.file.entry === header.path) {
          const root = readL4EnvironmentStructured(
            await readL4EnvironmentBounded(content),
            'yaml'
          ) as Record<string, unknown>
          const host = root['pi-desk'] as Record<string, unknown> | undefined
          const auth = host?.auth
          restoresAuth =
            auth !== undefined &&
            (auth === null || typeof auth !== 'object' || Object.keys(auth).length > 0)
        } else if (
          selected.some(({ file }) => file.base === 'desktop' && file.entry === header.path)
        )
          desktopContent = await readL4EnvironmentBounded(content, L4_ENVIRONMENT_DESKTOP_MAX_BYTES)
        else {
          const item = selected.find(({ file }) => file.secretEntry === header.path)
          if (!item) return
          Object.assign(
            isL4EnvironmentUnifiedConfig(item.file) ? inlineSecrets : archiveSecrets,
            JSON.parse((await readL4EnvironmentBounded(content)).toString('utf8')) as Record<
              string,
              string
            >
          )
        }
      }
    })
  }
  if (Object.keys(inlineSecrets).some((reference) => Object.hasOwn(archiveSecrets, reference))) {
    throw new Error('统一配置与旧保险库凭据引用冲突')
  }
  // 在恢复事务取得 YAML 文件锁之前准备本机密文，不写入配置分组。
  Object.assign(
    importedRefs,
    await importL4UnifiedConfigSecrets(
      inlineSecrets,
      bindConfigStore('pi-desk', 'environment', { agentDir: input.agentDir })
    )
  )
  const targets = hostFiles.map(({ target }) => target)
  if (restoresAuth) targets.push(join(input.agentDir, 'pi-desk', 'auth-session-key'))
  if (plan.workSessions.length) targets.push(join(input.agentDir, 'pi-desk', 'work-sessions.json'))
  if (desktopContent)
    plan.warnings.push('桌面配置已暂存，需完整退出并重启桌面后生效；Node 服务重启不等于桌面重启。')
  if (targets.length || desktopContent) {
    const cleanupWarnings = await applyL4EnvironmentTransaction({
      directory: input.directory,
      agentDir: input.agentDir,
      targets,
      lockTargets: plan.files
        .filter(
          ({ file }) =>
            file.category === 'config' &&
            file.format !== 'binary' &&
            (file.base === 'project' || (file.base === 'agent' && file.path.startsWith('config/')))
        )
        .map(({ target }) => target),
      validate: async (): Promise<void> => {
        await planL4EnvironmentImport(input)
      },
      completion: {
        phase: 'import-files-committed',
        warnings: [...input.manifest.warnings, ...plan.warnings]
      },
      store: input.rollbackStore,
      ...(desktopContent
        ? {
            desktop: {
              operationId: input.selection.id,
              stage: async (): Promise<void> => {
                await stageL4EnvironmentDesktop(input.agentDir, input.selection.id, desktopContent!)
              }
            }
          }
        : {}),
      async apply(): Promise<void> {
        if (Object.keys(archiveSecrets).length)
          Object.assign(importedRefs, await targetStore.import(archiveSecrets))
        // 离线窗口直接写最终目标；整包只流式读取一次，不落含原生凭据的明文临时文件。
        await readEnvironmentArchive({
          archivePath: input.archivePath,
          password: input.password,
          async consumeEntry(header, content): Promise<void> {
            const planned = hostEntries.get(header.path)
            if (!planned) return
            await mkdir(dirname(planned.target), { recursive: true, mode: 0o700 })
            await assertL4EnvironmentTarget(planned.target)
            if (planned.file.category === 'session')
              await pipeline(
                transformedSession(content, planned.file, planned.target, input.manifest, plan),
                createWriteStream(planned.target, { flags: 'w', mode: 0o600 })
              )
            else if (planned.file.format !== 'binary') {
              const transformed = transformL4EnvironmentConfig({
                content: await readL4EnvironmentBounded(content),
                file: planned.file,
                mappings: plan.mappings,
                sourcePlatform: platform(input.manifest),
                targetPlatform: process.platform === 'win32' ? 'win32' : 'posix',
                ...(planned.file.secretEntry ? { references: importedRefs } : {})
              })
              await pipeline(
                [transformed],
                createWriteStream(planned.target, { flags: 'w', mode: 0o600 })
              )
            } else
              await pipeline(
                content,
                createWriteStream(planned.target, { flags: 'w', mode: 0o600 })
              )
          }
        })
        if (restoresAuth) restoreL4AuthSessionKey(input.agentDir)
        if (plan.workSessions.length)
          await writeL4EnvironmentJson(
            join(input.agentDir, 'pi-desk', 'work-sessions.json'),
            await mergedWorkSessions(input.agentDir, plan.workSessions, plan.pinnedCount)
          )
      }
    })
    plan.warnings.push(...cleanupWarnings)
  }
  return plan.warnings
}
