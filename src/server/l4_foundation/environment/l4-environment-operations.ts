import { randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, readFile, readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { z } from 'zod'
import {
  L4EnvironmentSelectionSchema,
  L4EnvironmentOperationSchema,
  type L4EnvironmentExportOptions,
  type L4EnvironmentSelection,
  type L4EnvironmentOperation,
  type L4EnvironmentPreviewSummary
} from './l4-environment-state'
import { L4EnvironmentPreviewCache } from './l4-environment-preview-cache'
import { getL4EnvironmentOperationRoot, writeL4EnvironmentJson } from './l4-environment-maintenance'
import { collectL4Environment } from './l4-environment-collect'
import {
  groupL4EnvironmentFiles,
  inspectL4EnvironmentArchive,
  planL4EnvironmentImport,
  type L4EnvironmentPreview
} from './l4-environment-import'

export const L4_ENVIRONMENT_UPLOAD_LIMIT = 8 * 1024 ** 3
export const L4_ENVIRONMENT_OPERATION_TTL = 24 * 60 * 60 * 1000
export const L4EnvironmentMaintenanceRequestSchema = z.discriminatedUnion('kind', [
  z
    .object({
      id: z.string().uuid(),
      kind: z.literal('export'),
      agentDir: z.string(),
      cwd: z.string(),
      password: z.string().min(1).max(4096),
      includeSessions: z.boolean(),
      includePluginData: z.boolean()
    })
    .strict(),
  z
    .object({
      id: z.string().uuid(),
      kind: z.literal('import'),
      agentDir: z.string(),
      cwd: z.string(),
      password: z.string().min(1).max(4096),
      selection: L4EnvironmentSelectionSchema
    })
    .strict()
])
export type L4EnvironmentMaintenanceRequest = z.infer<typeof L4EnvironmentMaintenanceRequestSchema>

export async function updateL4EnvironmentOperation(
  directory: string,
  update: Partial<L4EnvironmentOperation>
): Promise<L4EnvironmentOperation> {
  const path = join(directory, 'operation.json')
  const previous = L4EnvironmentOperationSchema.parse(JSON.parse(await readFile(path, 'utf8')))
  const next = L4EnvironmentOperationSchema.parse({ ...previous, ...update })
  await writeL4EnvironmentJson(path, next)
  return next
}

/** 密码及解密预览只驻留当前服务内存；重连可读取持久结果，服务重启后重新预览才能提交。 */
export class L4EnvironmentOperations {
  private readonly previews = new Map<
    string,
    {
      password: string
      preview: L4EnvironmentPreview
      cache: L4EnvironmentPreviewCache
      expiresAt: number
    }
  >()
  private active: string | null = null

  constructor(
    private readonly options: {
      agentDir: string
      cwd: string
      canRestart: () => boolean
      schedule: (request: L4EnvironmentMaintenanceRequest) => void | Promise<void>
      uploadLimit?: number
    }
  ) {}

  directory(id: string): string {
    z.string().uuid().parse(id)
    return join(getL4EnvironmentOperationRoot(this.options.agentDir), id)
  }

  private requireRestart(): void {
    if (!this.options.canRestart())
      throw new Error('当前启动方式不支持受管维护重启；不能在线备份或恢复')
    if (this.active) throw new Error('已有环境维护提交，等待重启完成')
  }

  private async cleanup(): Promise<void> {
    for (const [id, item] of this.previews)
      if (item.expiresAt <= Date.now()) {
        await item.cache.dispose()
        this.previews.delete(id)
      }
    const root = getL4EnvironmentOperationRoot(this.options.agentDir)
    const entries = await readdir(root, { withFileTypes: true }).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return []
        throw error
      }
    )
    for (const entry of entries) {
      if (!entry.isDirectory() || !z.string().uuid().safeParse(entry.name).success) continue
      const directory = this.directory(entry.name)
      // 无完成记录的上传残片也有寿命；不能清除未恢复的提交现场。
      if (
        await stat(join(directory, 'journal.json')).then(
          () => true,
          () => false
        )
      )
        continue
      const raw = await readFile(join(directory, 'operation.json'), 'utf8').catch(() => null)
      const operation = raw ? L4EnvironmentOperationSchema.parse(JSON.parse(raw)) : null
      const expired = operation
        ? operation.expiresAt <= Date.now()
        : (await stat(directory)).mtimeMs + L4_ENVIRONMENT_OPERATION_TTL <= Date.now()
      if (expired && entry.name !== this.active && operation?.status !== 'running')
        await rm(directory, { recursive: true, force: true })
    }
  }

  private async create(
    kind: 'export' | 'import',
    status: 'pending' | 'ready',
    phase: string
  ): Promise<L4EnvironmentOperation> {
    await this.cleanup()
    const operation: L4EnvironmentOperation = {
      id: randomUUID(),
      kind,
      status,
      phase,
      error: null,
      warnings: [],
      expiresAt: Date.now() + L4_ENVIRONMENT_OPERATION_TTL
    }
    await mkdir(this.directory(operation.id), { recursive: true, mode: 0o700 })
    await writeL4EnvironmentJson(join(this.directory(operation.id), 'operation.json'), operation)
    return operation
  }

  async get(id: string): Promise<L4EnvironmentOperation> {
    const operation = L4EnvironmentOperationSchema.parse(
      JSON.parse(await readFile(join(this.directory(id), 'operation.json'), 'utf8'))
    )
    if (operation.expiresAt <= Date.now()) {
      await this.cleanup()
      throw new Error('环境操作已过期，请重新开始')
    }
    return operation
  }

  async upload(
    body: ReadableStream<Uint8Array>,
    contentLength?: string | null
  ): Promise<{ id: string }> {
    const maximum = this.options.uploadLimit ?? L4_ENVIRONMENT_UPLOAD_LIMIT
    if (contentLength && (!/^\d+$/.test(contentLength) || Number(contentLength) > maximum))
      throw new Error('备份上传超过独立容量限制')
    const operation = await this.create('import', 'ready', 'uploaded')
    const directory = this.directory(operation.id)
    let bytes = 0
    try {
      await pipeline(
        Readable.fromWeb(body as import('node:stream/web').ReadableStream<Uint8Array>),
        new Transform({
          transform(chunk: Buffer, _encoding, callback): void {
            bytes += chunk.length
            callback(bytes > maximum ? new Error('备份上传超过独立容量限制') : null, chunk)
          }
        }),
        createWriteStream(join(directory, 'archive.enc'), { flags: 'wx', mode: 0o600 })
      )
      if (!bytes) throw new Error('备份上传为空')
      return { id: operation.id }
    } catch (error) {
      await rm(directory, { recursive: true, force: true })
      throw error
    }
  }

  async preview(
    id: string,
    password: string,
    mappings: { from: string; to: string }[] = []
  ): Promise<L4EnvironmentPreviewSummary> {
    const operation = await this.get(id)
    if (operation.kind !== 'import' || operation.status !== 'ready')
      throw new Error('当前操作不可预览')
    let cached = this.previews.get(id)
    if (cached && cached.password !== password) {
      await cached.cache.dispose()
      this.previews.delete(id)
      cached = undefined
    }
    if (!cached) {
      const cache = new L4EnvironmentPreviewCache(
        join(this.directory(id), `preview-${randomUUID()}`)
      )
      try {
        const preview = await inspectL4EnvironmentArchive({
          id,
          password,
          archivePath: join(this.directory(id), 'archive.enc'),
          cache
        })
        cached = { password, preview, cache, expiresAt: operation.expiresAt }
        this.previews.set(id, cached)
      } catch (error) {
        await cache.dispose()
        throw error
      }
    }
    const conflicts = new Map<string, string[]>()
    await planL4EnvironmentImport({
      agentDir: this.options.agentDir,
      archivePath: join(this.directory(id), 'archive.enc'),
      password,
      manifest: cached.preview.manifest,
      selection: {
        id,
        selectedIds: cached.preview.summary.items.map((item) => item.id),
        mappings,
        overwrite: false
      },
      readEntries: cached.cache.read,
      previewConflicts: conflicts
    })
    const groups = groupL4EnvironmentFiles(cached.preview.manifest)
    return {
      ...cached.preview.summary,
      items: cached.preview.summary.items.map((item) => ({
        ...item,
        conflicts: [
          ...new Set(groups.get(item.id)!.flatMap((member) => conflicts.get(member.id) ?? []))
        ]
      }))
    }
  }

  async export(input: L4EnvironmentExportOptions): Promise<{ id: string }> {
    this.requireRestart()
    await collectL4Environment({
      agentDir: this.options.agentDir,
      cwd: this.options.cwd,
      includeSessions: false,
      includePluginData: input.includePluginData
    })
    const operation = await this.create('export', 'pending', 'awaiting-maintenance')
    await this.submit(operation.id, {
      id: operation.id,
      kind: 'export',
      agentDir: this.options.agentDir,
      cwd: this.options.cwd,
      ...input
    })
    return { id: operation.id }
  }

  async import(selection: L4EnvironmentSelection): Promise<{ id: string }> {
    this.requireRestart()
    const operation = await this.get(selection.id)
    const cached = this.previews.get(selection.id)
    if (
      operation.kind !== 'import' ||
      operation.status !== 'ready' ||
      !cached ||
      cached.expiresAt <= Date.now()
    )
      throw new Error('请先用密码完成当前服务内的解密预览')
    const plan = await planL4EnvironmentImport({
      agentDir: this.options.agentDir,
      archivePath: join(this.directory(selection.id), 'archive.enc'),
      password: cached.password,
      manifest: cached.preview.manifest,
      selection
    })
    await updateL4EnvironmentOperation(this.directory(selection.id), { warnings: plan.warnings })
    await this.submit(selection.id, {
      id: selection.id,
      kind: 'import',
      agentDir: this.options.agentDir,
      cwd: this.options.cwd,
      password: cached.password,
      selection
    })
    this.previews.delete(selection.id)
    void cached.cache
      .dispose()
      .catch(() =>
        console.warn('[Pi Desk][Environment] 预览暂存清理失败', { phase: 'preview-cleanup' })
      )
    return { id: selection.id }
  }

  private async submit(id: string, request: L4EnvironmentMaintenanceRequest): Promise<void> {
    this.requireRestart()
    this.active = id
    try {
      await updateL4EnvironmentOperation(this.directory(id), {
        status: 'pending',
        phase: 'awaiting-maintenance'
      })
      await this.options.schedule(request)
    } catch (error) {
      this.active = null
      await updateL4EnvironmentOperation(this.directory(id), {
        status: request.kind === 'import' ? 'ready' : 'failed',
        phase: request.kind === 'import' ? 'preview-ready' : 'restart-rejected',
        error:
          request.kind === 'import'
            ? null
            : '当前宿主未接纳维护重启；会话仍可接单，请待空闲或恢复重启能力后重新提交'
      })
      throw error
    }
  }

  async download(id: string): Promise<Response> {
    const operation = await this.get(id)
    if (operation.kind !== 'export' || operation.status !== 'ready')
      throw new Error('备份制品尚未就绪')
    const path = join(this.directory(id), 'archive.enc')
    const info = await stat(path)
    return new Response(Readable.toWeb(createReadStream(path)) as ReadableStream<Uint8Array>, {
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(info.size),
        'Content-Disposition': `attachment; filename="pi-desk-environment-${id}.pdesk"`,
        'Cache-Control': 'no-store'
      }
    })
  }

  async cancel(id: string): Promise<Record<string, never>> {
    const operation = await this.get(id)
    if (operation.status === 'pending' || operation.status === 'running' || this.active === id)
      throw new Error('环境维护已提交，不能取消或假报取消成功')
    if (
      await stat(join(this.directory(id), 'journal.json')).then(
        () => true,
        () => false
      )
    )
      throw new Error('回滚现场尚未恢复，不能删除')
    await this.previews.get(id)?.cache.dispose()
    this.previews.delete(id)
    await rm(this.directory(id), { recursive: true, force: true })
    return {}
  }
}
