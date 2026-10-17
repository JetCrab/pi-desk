import { existsSync } from 'node:fs'
import { appendFile, mkdir, realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import {
  CONFIG_RELATIVE_PATH,
  WorkspaceError,
  appendCompletedOperation,
  appendRunningOperation,
  assertMarkerIdentity,
  availableMarker,
  collectProtectedLogPaths,
  commandInput,
  containsPath,
  createCommandRunPaths,
  createOccupation,
  createWorkspaceId,
  ensureWorkspaceBase,
  finishLastOperation,
  formatWorkspaceRef,
  getWorkspace,
  listWorkspaces,
  loadConfigForSession,
  markerBase,
  occupiedMarker,
  parseWorkspaceRef,
  readCommandResult,
  readMarker,
  reconcileInterruptedOperations,
  resolveHandlerPath,
  restoreActiveSelection,
  validateParameters,
  verifyWorkspace,
  workspaceBaseRoot,
  workspaceRoot,
  writeCommandInput,
  writeMarker,
  type Definition,
  type Exec,
  type NodeHandler,
  type WorkspaceCommand,
  type WorkspaceCommandResult,
  type WorkspaceConfig,
  type WorkspaceRecord,
  type WorkspaceSelection
} from './core.js'
import type {
  JsonValue,
  ParametersSchema,
  WorkspaceChangedEvent,
  WorkspaceCommandSummary,
  WorkspaceDefinitionSummary,
  WorkspaceSnapshot,
  WorkspaceSnapshotItem,
  WorkspaceStatus
} from './contract.js'
import type { WorkspaceExternalOperation } from './workspace-operation-event.js'
import { WORKSPACE_TITLE_LIMIT, shortWorkspaceTitle } from './l4-workspace-title.js'

export type WorkspaceRuntimeContext = {
  cwd: string
  trusted: boolean
  sessionId: string
}

export type WorkspaceAcquireInput = {
  definition: string
  requirement: string
  parameters?: Record<string, JsonValue>
}

export type WorkspaceRunInput = {
  workspace?: string
  command: string
  parameters?: Record<string, JsonValue>
}

export type WorkspaceAcquireResult = {
  workspaceRef: string
  requirement: string
  root: string
  definition: string
  snapshot: WorkspaceSnapshot
}

export type WorkspaceRunResult = {
  workspaceId: string
  command: string
  summary?: string
  logPath: string
  snapshot: WorkspaceSnapshot
}

export type WorkspaceTaskHandle = {
  complete(activity?: string): void
  fail(activity?: string): void
  stopped(activity?: string): void
}

export type WorkspaceTaskInput = {
  taskKind?: string
  taskType?: string
  title: string
  info?: readonly { label: string; value: string }[]
  activity?: string
  detailSource?: { kind: 'text-file'; path: string }
  interrupt?: () => Promise<void>
}

export type WorkspaceRuntimeDependencies = {
  exec: Exec
  runnerPath: string
  poolRoot?: string
  persist(selection: WorkspaceSelection | null): void
  changed(event: WorkspaceChangedEvent): void
  previewDirectoryChanged?(directory: string): void
  startTask?(input: WorkspaceTaskInput): WorkspaceTaskHandle
}

const lockChains = new Map<string, Promise<void>>()

async function withLock<T>(key: string, execute: () => Promise<T>): Promise<T> {
  const previous = lockChains.get(key) ?? Promise.resolve()
  let release: (() => void) | undefined
  const current = new Promise<void>((resolve) => {
    release = resolve
  })
  const chain = previous.then(() => current)
  lockChains.set(key, chain)
  await previous
  try {
    return await execute()
  } finally {
    release?.()
    if (lockChains.get(key) === chain) lockChains.delete(key)
  }
}

function parametersOrEmpty(schema: ParametersSchema | undefined): ParametersSchema {
  return schema ?? { properties: {} }
}

function commandSummary(command: WorkspaceCommand): WorkspaceCommandSummary {
  return {
    id: command.id,
    description: command.description,
    from: [...command.from],
    onSuccess: command.onSuccess,
    parameters: parametersOrEmpty(command.parameters)
  }
}

function definitionSummary(definition: Definition): WorkspaceDefinitionSummary {
  return {
    id: definition.id,
    description: definition.description,
    provision: {
      description: definition.provision.description,
      parameters: parametersOrEmpty(definition.provision.parameters)
    },
    commands: Object.values(definition.commands).map(commandSummary)
  }
}

function statusText(status: WorkspaceStatus): string {
  return status === 'available' ? '可用' : '占用'
}

function requireTrusted(context: WorkspaceRuntimeContext): void {
  if (!context.trusted) throw new WorkspaceError('当前项目尚未信任，不能使用工作区')
}

function selectionEquals(
  left: WorkspaceSelection | undefined,
  right: WorkspaceSelection | undefined
): boolean {
  return left?.workspaceId === right?.workspaceId && left?.assignmentId === right?.assignmentId
}

function combineSignals(external: AbortSignal | undefined, internal: AbortController): () => void {
  if (!external) return () => undefined
  if (external.aborted) {
    internal.abort()
    return () => undefined
  }
  const abort = () => internal.abort()
  external.addEventListener('abort', abort, { once: true })
  return () => external.removeEventListener('abort', abort)
}

export class WorkspaceRuntime {
  private active: WorkspaceSelection | undefined
  private previewDirectory: string | undefined
  private interruptedOperationsReconciled = false
  private readonly runningControllers = new Set<AbortController>()

  constructor(private readonly dependencies: WorkspaceRuntimeDependencies) {}

  get activeRef(): string | null {
    return this.active
      ? formatWorkspaceRef(this.active.workspaceId, this.active.assignmentId)
      : null
  }

  async restore(
    context: WorkspaceRuntimeContext,
    entries: Array<{ type?: string; customType?: string; data?: unknown }>
  ): Promise<void> {
    this.active = restoreActiveSelection(entries)
    this.previewDirectory = undefined
    if (!this.interruptedOperationsReconciled) {
      await this.reconcileInterruptedOperationRecords(context)
      this.interruptedOperationsReconciled = true
    }
    await this.validateActive(context)
  }

  async snapshot(context: WorkspaceRuntimeContext): Promise<WorkspaceSnapshot> {
    const configPath = join(context.cwd, CONFIG_RELATIVE_PATH)
    if (!context.trusted) {
      this.active = undefined
      this.syncPreviewDirectory(context)
      return {
        trusted: false,
        config: { status: 'missing', path: configPath, error: null },
        definitions: [],
        workspaces: [],
        active: null
      }
    }

    const loaded = await loadConfigForSession(context.cwd)
    if (!loaded.config) {
      this.active = undefined
      this.syncPreviewDirectory(context)
      return {
        trusted: true,
        config: {
          status: loaded.warning ? 'invalid' : 'missing',
          path: configPath,
          error: loaded.warning ?? null
        },
        definitions: [],
        workspaces: [],
        active: null
      }
    }

    await this.validateActive(context, loaded.config)
    const baseRoot = this.baseRoot(context.cwd)
    const records = await listWorkspaces(context.cwd, baseRoot)
    const workspaces = await Promise.all(
      records.map((record) => this.snapshotItem(baseRoot, loaded.config!, record))
    )

    return {
      trusted: true,
      config: { status: 'ready', path: configPath, error: null },
      definitions: Object.values(loaded.config.definitions).map(definitionSummary),
      workspaces,
      active: this.activeRef
    }
  }

  async acquire(
    context: WorkspaceRuntimeContext,
    input: WorkspaceAcquireInput,
    signal?: AbortSignal,
    onUpdate?: (message: string) => void
  ): Promise<WorkspaceAcquireResult> {
    requireTrusted(context)
    const config = await this.requireConfig(context.cwd)
    const definition = config.definitions[input.definition]
    if (!definition) throw new WorkspaceError(`不存在 definition：${input.definition}`)

    const provisionParameters = validateParameters(
      definition.provision.parameters,
      input.parameters,
      'parameters'
    )
    const requirement = input.requirement.trim()
    if (!requirement) throw new WorkspaceError('requirement 必须是非空字符串')
    // 只收紧新建入口；marker 仍兼容旧版保存的完整需求。
    if (/[\r\n\u2028\u2029]/u.test(requirement)) {
      throw new WorkspaceError('requirement 必须是单行需求名')
    }
    if (Array.from(requirement).length > WORKSPACE_TITLE_LIMIT) {
      throw new WorkspaceError(
        `requirement 不能超过 ${WORKSPACE_TITLE_LIMIT} 个字符，请使用简短需求名`
      )
    }

    const baseRoot = await ensureWorkspaceBase(context.cwd, this.dependencies.poolRoot)
    return withLock(`project:${baseRoot}`, async () => {
      const records = await listWorkspaces(context.cwd, baseRoot)
      const reusable: WorkspaceRecord[] = []
      for (const record of records) {
        if (record.marker.status !== 'available' || record.marker.definition !== definition.id) {
          continue
        }
        try {
          if (!isDeepStrictEqual(record.marker.provisionParameters, provisionParameters)) {
            continue
          }
          await verifyWorkspace(record, definition, baseRoot)
          reusable.push(record)
        } catch {
          // Invalid available records never enter the reusable pool.
        }
      }

      const record = reusable[0]
        ? await this.occupyReusable(context, reusable[0], definition, requirement, baseRoot)
        : await this.provisionNew(
            context,
            definition,
            requirement,
            provisionParameters,
            baseRoot,
            signal,
            onUpdate
          )

      if (record.marker.status !== 'occupied') {
        throw new WorkspaceError('acquire 完成后 workspace 未进入 occupied 状态')
      }
      const selection = {
        workspaceId: record.id,
        assignmentId: record.marker.occupation.id
      }
      this.setActive(selection)
      const snapshot = await this.snapshot(context)
      return {
        workspaceRef: formatWorkspaceRef(selection.workspaceId, selection.assignmentId),
        requirement,
        root: record.root,
        definition: definition.id,
        snapshot
      }
    })
  }

  async use(
    context: WorkspaceRuntimeContext,
    workspaceRef: string | null
  ): Promise<WorkspaceSnapshot> {
    requireTrusted(context)
    if (workspaceRef === null) {
      this.setActive(undefined)
      return this.snapshot(context)
    }

    const config = await this.requireConfig(context.cwd)
    const selection = parseWorkspaceRef(workspaceRef)
    const baseRoot = this.baseRoot(context.cwd)
    const record = await getWorkspace(context.cwd, selection.workspaceId, baseRoot)
    const definition = config.definitions[record.marker.definition]
    if (!definition) throw new WorkspaceError('workspace definition 已不存在')
    if (
      record.marker.status !== 'occupied' ||
      record.marker.occupation.id !== selection.assignmentId
    ) {
      throw new WorkspaceError('workspace assignment 已失效或已经被重新分配')
    }
    await verifyWorkspace(record, definition, baseRoot)
    this.setActive(selection)
    return this.snapshot(context)
  }

  async run(
    context: WorkspaceRuntimeContext,
    input: WorkspaceRunInput,
    signal?: AbortSignal,
    onUpdate?: (message: string) => void
  ): Promise<WorkspaceRunResult> {
    requireTrusted(context)
    const config = await this.requireConfig(context.cwd)
    const locator = input.workspace ?? this.activeRef
    if (!locator) throw new WorkspaceError('未选择工作区；请先 acquire 或 use')

    const workspaceId = locator.includes('@') ? parseWorkspaceRef(locator).workspaceId : locator
    const baseRoot = this.baseRoot(context.cwd)

    return withLock(`workspace:${join(baseRoot, workspaceId)}`, async () => {
      let record = await getWorkspace(context.cwd, workspaceId, baseRoot)
      const definition = config.definitions[record.marker.definition]
      if (!definition) throw new WorkspaceError('workspace definition 已不存在')
      const command = definition.commands[input.command]
      if (!command) throw new WorkspaceError(`不存在 command：${input.command}`)

      const originalStatus = record.marker.status
      if (!command.from.includes(originalStatus)) {
        throw new WorkspaceError(
          `command ${command.id} 不允许从 ${statusText(originalStatus)} 状态执行`
        )
      }

      const parameters = validateParameters(command.parameters, input.parameters, 'parameters')
      if (record.marker.status === 'occupied') {
        if (!locator.includes('@')) {
          throw new WorkspaceError('occupied 工作区必须使用完整 workspaceRef')
        }
        const selection = parseWorkspaceRef(locator)
        if (record.marker.occupation.id !== selection.assignmentId) {
          throw new WorkspaceError('workspace assignment 已失效或已经被重新分配')
        }
      } else {
        const occupation = createOccupation(
          shortWorkspaceTitle(`维护命令：${command.id}`),
          context.sessionId
        )
        record = {
          ...record,
          marker: occupiedMarker(record.marker, occupation)
        }
        await writeMarker(record.root, record.marker, { baseRoot })
      }

      const executed = await this.executeHandler({
        context,
        baseRoot,
        record,
        commandId: command.id,
        handler: command,
        parameters,
        signal,
        onUpdate
      })

      if (executed.record.marker.status !== 'occupied') {
        throw new WorkspaceError('命令执行期间 workspace 状态意外变化')
      }
      const currentAssignment = executed.record.marker.occupation.id
      const expectedBase = markerBase({
        projectRoot: context.cwd,
        definition,
        root: executed.record.root,
        provisionParameters: executed.record.marker.provisionParameters
      })

      try {
        if (command.onSuccess === 'removed') {
          if (existsSync(executed.record.root)) {
            throw new WorkspaceError('Handler 返回成功，但 workspace root 仍存在')
          }
          this.clearActiveIf(record.id, currentAssignment)
        } else {
          const marker = await readMarker(executed.record.root, { baseRoot })
          if (!marker) throw new WorkspaceError('Handler 完成后 marker 不存在')
          assertMarkerIdentity(marker, expectedBase)
          if (marker.status !== 'occupied' || marker.occupation.id !== currentAssignment) {
            throw new WorkspaceError('Handler 修改了 workspace assignment')
          }

          await verifyWorkspace({ ...executed.record, marker }, definition, baseRoot)

          if (command.onSuccess === 'available') {
            await writeMarker(executed.record.root, availableMarker(expectedBase), { baseRoot })
            this.clearActiveIf(record.id, currentAssignment)
          } else {
            await writeMarker(executed.record.root, executed.record.marker, { baseRoot })
          }
        }
        executed.task?.complete(executed.result.summary ?? `${command.description}执行成功`)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        await this.persistFailedOperation(executed.record, baseRoot, message)
        executed.task?.fail(message)
        throw new WorkspaceError(`${message}；日志：${executed.logPath}`)
      }

      const summary = executed.result.summary ?? `${command.description}执行成功`
      this.dependencies.changed({ workspaceId: record.id, summary })
      return {
        workspaceId: record.id,
        command: command.id,
        ...(executed.result.summary ? { summary: executed.result.summary } : {}),
        logPath: executed.logPath,
        snapshot: await this.snapshot(context)
      }
    })
  }

  async recordExternalOperation(
    context: WorkspaceRuntimeContext,
    input: WorkspaceExternalOperation
  ): Promise<boolean> {
    if (!context.trusted) return false
    const loaded = await loadConfigForSession(context.cwd)
    if (!loaded.config) return false

    let directory: string
    try {
      directory = await realpath(input.directory)
    } catch {
      return false
    }

    const baseRoot = this.baseRoot(context.cwd)
    const records = await listWorkspaces(context.cwd, baseRoot)
    const matches: WorkspaceRecord[] = []
    for (const record of records) {
      if (record.marker.status !== 'occupied') continue
      try {
        const root = await realpath(record.root)
        if (containsPath(root, directory)) matches.push(record)
      } catch {
        // Invalid workspace roots cannot own an external operation.
      }
    }
    const matched = matches.sort((left, right) => right.root.length - left.root.length)[0]
    if (!matched) return false

    return withLock(`workspace:${matched.root}`, async () => {
      const record = await getWorkspace(context.cwd, matched.id, baseRoot)
      if (record.marker.status !== 'occupied') return false
      const definition = loaded.config!.definitions[record.marker.definition]
      if (!definition) return false
      await verifyWorkspace(record, definition, baseRoot)
      const root = await realpath(record.root)
      if (!containsPath(root, directory)) return false

      const occupation = appendCompletedOperation(record.marker.occupation, {
        command: input.command,
        startedAt: input.startedAt,
        endedAt: input.endedAt,
        result: input.result,
        summary: input.summary,
        logPath: input.logPath
      })
      await writeMarker(record.root, occupiedMarker(record.marker, occupation), { baseRoot })
      this.dependencies.changed({
        workspaceId: record.id,
        summary: `已记录外部操作 ${input.command}`
      })
      return true
    })
  }

  async promptContext(context: WorkspaceRuntimeContext): Promise<string | undefined> {
    if (!context.trusted) return undefined
    const loaded = await loadConfigForSession(context.cwd)
    if (!loaded.config) return undefined

    const definitions = Object.values(loaded.config.definitions)
      .map((definition) => `${definition.id}（${definition.description}）`)
      .join('；')
    let value = `Workspace：可用 definitions：${definitions}。需要隔离目录时调用 workspace acquire，插件会返回初始化完成的 workspace root。`

    const active = await this.activeRecord(context, loaded.config)
    if (active?.marker.status === 'occupied') {
      const definition = loaded.config.definitions[active.marker.definition]!
      const commands = Object.values(definition.commands)
        .filter((command) => command.from.includes('occupied'))
        .map((command) => `${command.id}（${command.description}）`)
        .join('；')
      value += ` 当前 active：${formatWorkspaceRef(active.id, active.marker.occupation.id)}，需求：${active.marker.occupation.requirement}，工作区目录：${active.root}。处理文件时显式使用该目录。可执行 commands：${commands || '无'}。`
    }
    return value
  }

  shutdown(): void {
    for (const controller of this.runningControllers) controller.abort()
    this.runningControllers.clear()
    this.active = undefined
    this.previewDirectory = undefined
  }

  private baseRoot(projectRoot: string): string {
    return workspaceBaseRoot(projectRoot, this.dependencies.poolRoot)
  }

  private async reconcileInterruptedOperationRecords(
    context: WorkspaceRuntimeContext
  ): Promise<void> {
    if (!context.trusted) return
    const baseRoot = this.baseRoot(context.cwd)
    const records = await listWorkspaces(context.cwd, baseRoot)
    for (const record of records) {
      if (record.marker.status !== 'occupied') continue
      await withLock(`workspace:${record.root}`, async () => {
        const current = await getWorkspace(context.cwd, record.id, baseRoot)
        if (current.marker.status !== 'occupied') return
        const occupation = reconcileInterruptedOperations(current.marker.occupation)
        if (isDeepStrictEqual(occupation, current.marker.occupation)) return
        await writeMarker(current.root, occupiedMarker(current.marker, occupation), { baseRoot })
      })
    }
  }

  private async requireConfig(projectRoot: string): Promise<WorkspaceConfig> {
    const loaded = await loadConfigForSession(projectRoot)
    if (loaded.warning) throw new WorkspaceError(loaded.warning)
    if (!loaded.config) throw new WorkspaceError('未找到 .pi/workspace.yml')
    return loaded.config
  }

  private async validateActive(
    context: WorkspaceRuntimeContext,
    configInput?: WorkspaceConfig
  ): Promise<void> {
    if (!this.active || !context.trusted) {
      if (!context.trusted) this.active = undefined
      this.syncPreviewDirectory(context)
      return
    }
    try {
      const config = configInput ?? (await this.requireConfig(context.cwd))
      const baseRoot = this.baseRoot(context.cwd)
      const record = await getWorkspace(context.cwd, this.active.workspaceId, baseRoot)
      const definition = config.definitions[record.marker.definition]
      if (!definition) throw new WorkspaceError('workspace definition 已不存在')
      if (
        record.marker.status !== 'occupied' ||
        record.marker.occupation.id !== this.active.assignmentId
      ) {
        throw new WorkspaceError('workspace assignment 已失效')
      }
      await verifyWorkspace(record, definition, baseRoot)
    } catch {
      this.active = undefined
    }
    this.syncPreviewDirectory(context)
  }

  private syncPreviewDirectory(context: WorkspaceRuntimeContext): void {
    const directory = this.active
      ? workspaceRoot(this.active.workspaceId, this.baseRoot(context.cwd))
      : context.cwd
    if (directory === this.previewDirectory) return
    this.previewDirectory = directory
    this.dependencies.previewDirectoryChanged?.(directory)
  }

  private async activeRecord(
    context: WorkspaceRuntimeContext,
    config: WorkspaceConfig
  ): Promise<WorkspaceRecord | undefined> {
    await this.validateActive(context, config)
    if (!this.active) return undefined
    return getWorkspace(context.cwd, this.active.workspaceId, this.baseRoot(context.cwd))
  }

  private async snapshotItem(
    baseRoot: string,
    config: WorkspaceConfig,
    record: WorkspaceRecord
  ): Promise<WorkspaceSnapshotItem> {
    let issue: string | null = null
    const definition = config.definitions[record.marker.definition]
    try {
      if (!definition) throw new WorkspaceError('workspace definition 已不存在')
      await verifyWorkspace(record, definition, baseRoot)
    } catch (error) {
      issue = (error as Error).message
    }

    const workspaceRef =
      record.marker.status === 'occupied'
        ? formatWorkspaceRef(record.id, record.marker.occupation.id)
        : null
    return {
      id: record.id,
      workspaceRef,
      definition: record.marker.definition,
      root: record.root,
      status: record.marker.status,
      occupation: record.marker.occupation,
      active:
        record.marker.status === 'occupied' &&
        selectionEquals(this.active, {
          workspaceId: record.id,
          assignmentId: record.marker.occupation.id
        }),
      issue
    }
  }

  private async occupyReusable(
    context: WorkspaceRuntimeContext,
    record: WorkspaceRecord,
    definition: Definition,
    requirement: string,
    baseRoot: string
  ): Promise<WorkspaceRecord> {
    const base = markerBase({
      projectRoot: context.cwd,
      definition,
      root: record.root,
      provisionParameters: record.marker.provisionParameters
    })
    const marker = occupiedMarker(base, createOccupation(requirement, context.sessionId))
    await writeMarker(record.root, marker, { baseRoot })
    this.dependencies.changed({ workspaceId: record.id, summary: '工作区已分配' })
    return { ...record, marker }
  }

  private async provisionNew(
    context: WorkspaceRuntimeContext,
    definition: Definition,
    requirement: string,
    provisionParameters: Record<string, JsonValue>,
    baseRoot: string,
    signal?: AbortSignal,
    onUpdate?: (message: string) => void
  ): Promise<WorkspaceRecord> {
    let id = createWorkspaceId()
    let root = workspaceRoot(id, baseRoot)
    for (;;) {
      try {
        await mkdir(root, { recursive: false })
        break
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        id = createWorkspaceId()
        root = workspaceRoot(id, baseRoot)
      }
    }

    const base = markerBase({
      projectRoot: context.cwd,
      definition,
      root,
      provisionParameters
    })
    let record: WorkspaceRecord = {
      id,
      root,
      marker: occupiedMarker(base, createOccupation(requirement, context.sessionId))
    }
    await writeMarker(root, record.marker, { baseRoot })

    try {
      const executed = await this.executeHandler({
        context,
        baseRoot,
        record,
        commandId: 'provision',
        handler: definition.provision,
        parameters: provisionParameters,
        signal,
        onUpdate
      })
      try {
        await verifyWorkspace(executed.record, definition, baseRoot)
        await writeMarker(root, executed.record.marker, { baseRoot })
        executed.task?.complete(executed.result.summary ?? '工作区初始化完成')
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        await this.persistFailedOperation(executed.record, baseRoot, message)
        executed.task?.fail(message)
        throw new WorkspaceError(`${message}；日志：${executed.logPath}`)
      }
      record = executed.record
      this.dependencies.changed({
        workspaceId: id,
        summary: executed.result.summary ?? '工作区初始化完成'
      })
      return record
    } catch (error) {
      this.dependencies.changed({ workspaceId: id, summary: '工作区初始化失败' })
      throw error
    }
  }

  private async executeHandler(options: {
    context: WorkspaceRuntimeContext
    baseRoot: string
    record: WorkspaceRecord
    commandId: string
    handler: NodeHandler
    parameters: Record<string, JsonValue>
    signal?: AbortSignal
    onUpdate?: (message: string) => void
  }): Promise<{
    record: WorkspaceRecord
    result: Extract<WorkspaceCommandResult, { success: true }>
    logPath: string
    task?: WorkspaceTaskHandle
  }> {
    if (options.record.marker.status !== 'occupied') {
      throw new WorkspaceError('命令执行前工作区必须是 occupied')
    }

    const handlerPath = await resolveHandlerPath(options.context.cwd, options.handler.handler)
    const protectedLogs = await collectProtectedLogPaths(options.context.cwd, options.baseRoot)
    const paths = await createCommandRunPaths(options.context.cwd, protectedLogs)
    await writeFile(
      paths.logPath,
      `Workspace command ${options.commandId}\nHandler: ${handlerPath}\nInput: ${paths.inputPath}\nOutput: ${paths.outputPath}\n`,
      'utf8'
    )

    const occupation = appendRunningOperation(options.record.marker.occupation, {
      command: options.commandId,
      startedAt: Date.now(),
      logPath: paths.logPath
    })
    let record: WorkspaceRecord = {
      ...options.record,
      marker: occupiedMarker(options.record.marker, occupation)
    }
    await writeMarker(record.root, record.marker, { baseRoot: options.baseRoot })
    await writeCommandInput(
      paths.inputPath,
      commandInput({
        command: options.commandId,
        projectRoot: options.context.cwd,
        record,
        parameters: options.parameters
      })
    )

    const controller = new AbortController()
    const detachSignal = combineSignals(options.signal, controller)
    this.runningControllers.add(controller)
    let task: WorkspaceTaskHandle | undefined
    let taskSettled = false
    const failTask = (message: string): void => {
      if (taskSettled) return
      taskSettled = true
      if (controller.signal.aborted) task?.stopped('工作区命令已中断')
      else task?.fail(message)
    }

    try {
      task = this.dependencies.startTask?.({
        taskKind: '工作区',
        taskType: options.commandId,
        title: `${options.record.marker.occupation.requirement} · ${options.handler.description}`,
        info: [
          { label: '工作区', value: options.record.id },
          { label: '需求', value: options.record.marker.occupation.requirement }
        ],
        activity: `正在执行 ${options.handler.description}`,
        detailSource: { kind: 'text-file', path: paths.logPath },
        interrupt: async () => controller.abort()
      })
      options.onUpdate?.(`执行 ${options.commandId}：${options.handler.description}`)
      let executionError: Error | undefined
      const execution = await this.dependencies
        .exec(
          process.execPath,
          [
            this.dependencies.runnerPath,
            handlerPath,
            paths.inputPath,
            paths.outputPath,
            paths.logPath
          ],
          {
            cwd: options.context.cwd,
            signal: controller.signal,
            ...(options.handler.timeoutSeconds
              ? { timeout: options.handler.timeoutSeconds * 1000 }
              : {})
          }
        )
        .catch((error: unknown) => {
          executionError = error instanceof Error ? error : new Error(String(error))
          return { stdout: '', stderr: '', code: null }
        })

      if (execution.stderr) {
        await appendFile(paths.logPath, `\nRunner stderr:\n${execution.stderr}\n`, 'utf8')
      }

      let result: WorkspaceCommandResult
      try {
        result = await readCommandResult(paths.outputPath)
      } catch (error) {
        const message = executionError?.message ?? (error as Error).message
        await this.persistFailedOperation(record, options.baseRoot, message)
        failTask(message)
        throw new WorkspaceError(`${message}；日志：${paths.logPath}`)
      }

      if (executionError || execution.code !== 0 || !result.success) {
        const message =
          executionError?.message ??
          (result.success ? `Runner 退出码 ${String(execution.code)}` : result.error)
        await this.persistFailedOperation(record, options.baseRoot, message)
        failTask(message)
        throw new WorkspaceError(`${message}；日志：${paths.logPath}`)
      }

      if (record.marker.status !== 'occupied') {
        throw new WorkspaceError('命令执行期间 workspace 状态意外变化')
      }
      record = {
        ...record,
        marker: occupiedMarker(
          record.marker,
          finishLastOperation(record.marker.occupation, 'success', result.summary)
        )
      }
      return { record, result, logPath: paths.logPath, ...(task ? { task } : {}) }
    } catch (error) {
      failTask(error instanceof Error ? error.message : String(error))
      throw error
    } finally {
      detachSignal()
      this.runningControllers.delete(controller)
    }
  }

  private async persistFailedOperation(
    record: WorkspaceRecord,
    baseRoot: string,
    summary: string
  ): Promise<void> {
    if (!existsSync(record.root) || record.marker.status !== 'occupied') return
    const marker = occupiedMarker(
      record.marker,
      finishLastOperation(record.marker.occupation, 'failed', summary)
    )
    await writeMarker(record.root, marker, { baseRoot })
  }

  private setActive(selection: WorkspaceSelection | undefined): void {
    if (selectionEquals(this.active, selection)) return
    this.active = selection
    this.dependencies.persist(selection ?? null)
    this.dependencies.changed({
      workspaceId: selection?.workspaceId ?? null,
      summary: selection ? '已切换当前工作区' : '已清除当前工作区'
    })
  }

  private clearActiveIf(workspaceId: string, assignmentId: string | null): void {
    if (
      this.active?.workspaceId === workspaceId &&
      (!assignmentId || this.active.assignmentId === assignmentId)
    ) {
      this.setActive(undefined)
    }
  }
}
