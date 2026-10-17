import { createHash, randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile
} from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { isAlias, parseDocument } from 'yaml'
import type {
  JsonValue,
  ParameterItemSchema,
  ParameterProperty,
  ParametersSchema,
  WorkspaceCommandTarget,
  WorkspaceOccupation,
  WorkspaceOperation,
  WorkspaceStatus
} from './contract.js'

export const CONFIG_RELATIVE_PATH = join('.pi', 'workspace.yml')
export const CONFIG_SCHEMA = 'pi.workspace/v3'
export const WORKSPACE_METADATA_DIRECTORY = '.pi-workspace'
export const MARKER_FILE = join(WORKSPACE_METADATA_DIRECTORY, 'workspace.json')
export const MARKER_SCHEMA = 'pi.workspace-instance/v4'
const LEGACY_MARKER_SCHEMA = 'pi.workspace-instance/v3'
export const COMMAND_INPUT_SCHEMA = 'pi.workspace-command/v2'
export const COMMAND_RESULT_SCHEMA = 'pi.workspace-command-result/v1'
export const SELECTION_ENTRY = 'workspace-selection-v2'
export const MAX_OPERATIONS = 50

const ALLOWED_STATUSES = new Set<WorkspaceStatus>(['available', 'occupied'])
const ALLOWED_TARGETS = new Set<WorkspaceCommandTarget>(['available', 'occupied', 'removed'])
const PARAMETER_TYPES = new Set(['string', 'boolean', 'integer', 'number', 'array'])
const DANGEROUS_NAMES = new Set(['__proto__', 'prototype', 'constructor'])
const WORKSPACE_ID_PATTERN = /^ws-[a-f0-9]{12}$/
const ASSIGNMENT_ID_PATTERN = /^as-[a-f0-9]{16}$/

export type NodeHandler = {
  description: string
  parameters?: ParametersSchema
  handler: string
  timeoutSeconds?: number
}

export type WorkspaceCommand = NodeHandler & {
  id: string
  from: WorkspaceStatus[]
  onSuccess: WorkspaceCommandTarget
}

export type Definition = {
  id: string
  description: string
  provision: NodeHandler
  commands: Record<string, WorkspaceCommand>
}

export type WorkspaceConfig = {
  path: string
  definitions: Record<string, Definition>
}

export type WorkspaceMarkerBase = {
  schema: typeof MARKER_SCHEMA
  definition: string
  projectRoot: string
  provisionParameters: Record<string, JsonValue>
}

export type AvailableWorkspaceMarker = WorkspaceMarkerBase & {
  status: 'available'
  occupation: null
}

export type OccupiedWorkspaceMarker = WorkspaceMarkerBase & {
  status: 'occupied'
  occupation: WorkspaceOccupation
}

export type WorkspaceMarker = AvailableWorkspaceMarker | OccupiedWorkspaceMarker

export type WorkspaceRecord = {
  id: string
  root: string
  marker: WorkspaceMarker
}

export type WorkspaceSelection = {
  workspaceId: string
  assignmentId: string
}

export type WorkspaceCommandInput = {
  schema: typeof COMMAND_INPUT_SCHEMA
  command: string
  project: {
    root: string
  }
  workspace: {
    id: string
    root: string
    definition: string
    provisionParameters: Record<string, JsonValue>
  }
  occupation: {
    id: string
    requirement: string
    occupiedAt: number
  }
  parameters: Record<string, JsonValue>
}

export type WorkspaceCommandResult =
  | {
      schema: typeof COMMAND_RESULT_SCHEMA
      success: true
      summary?: string
    }
  | {
      schema: typeof COMMAND_RESULT_SCHEMA
      success: false
      error: string
    }

export type ExecResult = {
  stdout: string
  stderr: string
  code: number | null
  killed?: boolean
}

export type Exec = (
  program: string,
  args: string[],
  options: {
    cwd: string
    signal?: AbortSignal
    timeout?: number
  }
) => Promise<ExecResult>

export type SafePaths = {
  baseRoot: string
  requireRoot?: boolean
}

export class WorkspaceError extends Error {
  readonly field?: string

  constructor(message: string, field?: string) {
    super(message)
    this.name = 'WorkspaceError'
    this.field = field
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOwn(value: object, key: string): boolean {
  return Object.hasOwn(value, key)
}

function fail(path: string, message: string): never {
  throw new WorkspaceError(`${path}: ${message}`, path)
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail(`${path}.${key}`, '不支持的字段')
  }
}

function requireObject(value: unknown, path: string): Record<string, unknown> {
  if (!isObject(value)) fail(path, '必须是对象')
  return value
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) fail(path, '必须是非空字符串')
  return value
}

function requireTimestamp(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) fail(path, '必须是 Unix 毫秒时间戳')
  return Number(value)
}

function assertKebabKey(value: string, path: string): void {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) || DANGEROUS_NAMES.has(value)) {
    fail(path, '必须是 kebab-case，且不能使用危险名称')
  }
}

export function isJsonValue(value: unknown): value is JsonValue {
  if (value === null) return true
  if (typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(isJsonValue)
  return isObject(value) && Object.values(value).every(isJsonValue)
}

function validateValue(
  value: unknown,
  schema: ParameterItemSchema,
  path: string
): asserts value is JsonValue {
  if (!isJsonValue(value)) fail(path, '必须是 JSON 值')

  const valid =
    schema.type === 'array'
      ? Array.isArray(value)
      : schema.type === 'integer'
        ? typeof value === 'number' && Number.isInteger(value)
        : schema.type === 'number'
          ? typeof value === 'number' && Number.isFinite(value)
          : typeof value === schema.type

  if (!valid) fail(path, `必须是 ${schema.type}`)
  if (schema.enum && !schema.enum.some((item) => isDeepStrictEqual(item, value))) {
    fail(path, '必须是 enum 中的值')
  }
  if (schema.type === 'array' && schema.items) {
    for (const [index, item] of (value as JsonValue[]).entries()) {
      validateValue(item, schema.items, `${path}[${index}]`)
    }
  }
}

function parseItemSchema(value: unknown, path: string): ParameterItemSchema {
  const object = requireObject(value, path)
  onlyKeys(object, ['type', 'description', 'enum', 'items'], path)

  const type = requireString(object.type, `${path}.type`)
  if (!PARAMETER_TYPES.has(type)) {
    fail(`${path}.type`, '仅支持 string、boolean、integer、number、array')
  }

  const schema: ParameterItemSchema = {
    type: type as ParameterItemSchema['type']
  }

  if (object.description !== undefined) {
    schema.description = requireString(object.description, `${path}.description`)
  }
  if (object.items !== undefined) {
    if (schema.type !== 'array') fail(`${path}.items`, '仅 array 支持 items')
    schema.items = parseItemSchema(object.items, `${path}.items`)
  }
  if (object.enum !== undefined) {
    if (!Array.isArray(object.enum) || object.enum.length === 0) {
      fail(`${path}.enum`, '必须是非空数组')
    }
    for (const [index, item] of object.enum.entries()) {
      validateValue(item, schema, `${path}.enum[${index}]`)
    }
    schema.enum = object.enum as JsonValue[]
  }

  return schema
}

function parseProperty(value: unknown, path: string): ParameterProperty {
  const object = requireObject(value, path)
  onlyKeys(object, ['type', 'required', 'description', 'default', 'enum', 'items'], path)

  if (typeof object.required !== 'boolean') {
    fail(`${path}.required`, '必须显式为 true 或 false')
  }

  const itemInput = Object.fromEntries(
    Object.entries(object).filter(([key]) => key !== 'required' && key !== 'default')
  )
  const property: ParameterProperty = {
    ...parseItemSchema(itemInput, path),
    required: object.required
  }

  if (object.default !== undefined) {
    validateValue(object.default, property, `${path}.default`)
    property.default = object.default
  }

  return property
}

function parseParameters(value: unknown, path: string): ParametersSchema | undefined {
  if (value === undefined) return undefined

  const object = requireObject(value, path)
  onlyKeys(object, ['type', 'additionalProperties', 'properties'], path)
  if (object.type !== 'object') fail(`${path}.type`, '必须是 object')
  if (object.additionalProperties !== false) {
    fail(`${path}.additionalProperties`, '必须为 false')
  }

  const rawProperties = requireObject(object.properties, `${path}.properties`)
  const properties: Record<string, ParameterProperty> = Object.create(null)
  for (const [name, property] of Object.entries(rawProperties)) {
    assertKebabKey(name, `${path}.properties.${name}`)
    properties[name] = parseProperty(property, `${path}.properties.${name}`)
  }
  return { properties }
}

function requireHandlerPath(value: unknown, path: string): string {
  const handler = requireString(value, path)
  if (
    handler.includes('\\') ||
    handler.includes('\0') ||
    isAbsolute(handler) ||
    !handler.endsWith('.mjs')
  ) {
    fail(path, '必须是 .pi/workspace/ 下使用 / 分隔的 .mjs 相对路径')
  }
  const segments = handler.split('/')
  if (
    segments.some((segment) => !segment || segment === '.' || segment === '..') ||
    segments[0] !== '.pi' ||
    segments[1] !== 'workspace'
  ) {
    fail(path, '必须位于 .pi/workspace/ 内且不能越界')
  }
  return handler
}

function parseTimeout(value: unknown, path: string): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isSafeInteger(value) || Number(value) <= 0) fail(path, '必须是正整数')
  return Number(value)
}

function parseNodeHandler(
  value: unknown,
  path: string,
  allowedKeys: readonly string[]
): NodeHandler {
  const object = requireObject(value, path)
  onlyKeys(object, allowedKeys, path)

  const parameters = parseParameters(object.parameters, `${path}.parameters`)
  const timeoutSeconds = parseTimeout(object.timeoutSeconds, `${path}.timeoutSeconds`)
  return {
    description: requireString(object.description, `${path}.description`),
    handler: requireHandlerPath(object.handler, `${path}.handler`),
    ...(parameters ? { parameters } : {}),
    ...(timeoutSeconds ? { timeoutSeconds } : {})
  }
}

function parseCommand(id: string, value: unknown, path: string): WorkspaceCommand {
  const object = requireObject(value, path)
  const handler = parseNodeHandler(value, path, [
    'description',
    'from',
    'onSuccess',
    'parameters',
    'handler',
    'timeoutSeconds'
  ])

  if (!Array.isArray(object.from) || object.from.length === 0) {
    fail(`${path}.from`, '必须是非空状态数组')
  }
  const from: WorkspaceStatus[] = []
  for (const [index, state] of object.from.entries()) {
    if (typeof state !== 'string' || !ALLOWED_STATUSES.has(state as WorkspaceStatus)) {
      fail(`${path}.from[${index}]`, '仅支持 available、occupied')
    }
    if (!from.includes(state as WorkspaceStatus)) from.push(state as WorkspaceStatus)
  }

  if (
    typeof object.onSuccess !== 'string' ||
    !ALLOWED_TARGETS.has(object.onSuccess as WorkspaceCommandTarget)
  ) {
    fail(`${path}.onSuccess`, '仅支持 available、occupied、removed')
  }

  return {
    ...handler,
    id,
    from,
    onSuccess: object.onSuccess as WorkspaceCommandTarget
  }
}

function parseDefinition(id: string, value: unknown, path: string): Definition {
  const object = requireObject(value, path)
  onlyKeys(object, ['description', 'provision', 'commands'], path)

  const commandsInput = requireObject(object.commands, `${path}.commands`)
  if (Object.keys(commandsInput).length === 0) {
    fail(`${path}.commands`, '必须是非空命令 map')
  }

  const commands: Record<string, WorkspaceCommand> = Object.create(null)
  for (const [commandId, command] of Object.entries(commandsInput)) {
    assertKebabKey(commandId, `${path}.commands.${commandId}`)
    commands[commandId] = parseCommand(commandId, command, `${path}.commands.${commandId}`)
  }

  return {
    id,
    description: requireString(object.description, `${path}.description`),
    provision: parseNodeHandler(object.provision, `${path}.provision`, [
      'description',
      'parameters',
      'handler',
      'timeoutSeconds'
    ]),
    commands
  }
}

export function parseConfig(source: string, filePath: string): WorkspaceConfig {
  let document
  try {
    document = parseDocument(source, {
      version: '1.2',
      uniqueKeys: true,
      prettyErrors: true,
      strict: true
    })
  } catch (error) {
    throw new WorkspaceError(`${filePath}: ${(error as Error).message}`)
  }

  if (document.errors.length > 0) {
    throw new WorkspaceError(
      `${filePath}: ${document.errors.map((error) => error.message).join('; ')}`
    )
  }
  if (!document.contents) fail(filePath, '配置不能为空')

  let forbidden = false
  const inspect = (node: unknown): void => {
    if (!node || typeof node !== 'object') return
    const value = node as {
      anchor?: unknown
      tag?: unknown
      items?: unknown[]
      key?: unknown
      value?: unknown
    }
    if (
      isAlias(node) ||
      typeof value.anchor === 'string' ||
      (typeof value.tag === 'string' && value.tag.startsWith('!'))
    ) {
      forbidden = true
    }
    value.items?.forEach(inspect)
    inspect(value.key)
    inspect(value.value)
  }
  inspect(document.contents)

  if (forbidden || /(^|[\s\[{,])!\S/m.test(source)) {
    fail(filePath, '不允许 anchors、aliases 或自定义 tags')
  }
  if ((source.match(/^---\s*$/gm)?.length ?? 0) > 1 || /^\.\.\.\s*$/m.test(source)) {
    fail(filePath, '不允许多文档')
  }

  const root = requireObject(document.toJS(), filePath)
  onlyKeys(root, ['schema', 'definitions'], filePath)
  if (root.schema !== CONFIG_SCHEMA) {
    fail(`${filePath}.schema`, `仅支持 ${CONFIG_SCHEMA}`)
  }

  const definitionsInput = requireObject(root.definitions, `${filePath}.definitions`)
  if (Object.keys(definitionsInput).length === 0) {
    fail(`${filePath}.definitions`, '必须是非空 map')
  }

  const definitions: Record<string, Definition> = Object.create(null)
  for (const [id, definition] of Object.entries(definitionsInput)) {
    assertKebabKey(id, `${filePath}.definitions.${id}`)
    definitions[id] = parseDefinition(id, definition, `${filePath}.definitions.${id}`)
  }

  return { path: filePath, definitions }
}

export async function loadConfig(projectRoot: string): Promise<WorkspaceConfig | undefined> {
  const path = join(projectRoot, CONFIG_RELATIVE_PATH)
  if (!existsSync(path)) return undefined
  return parseConfig(await readFile(path, 'utf8'), path)
}

export async function loadConfigForSession(projectRoot: string): Promise<{
  config?: WorkspaceConfig
  warning?: string
}> {
  const path = join(projectRoot, CONFIG_RELATIVE_PATH)
  if (!existsSync(path)) return {}
  try {
    return { config: await loadConfig(projectRoot) }
  } catch (error) {
    return { warning: `Workspace 配置无效：${(error as Error).message}` }
  }
}

export function validateParameters(
  schema: ParametersSchema | undefined,
  supplied: unknown,
  path = 'parameters'
): Record<string, JsonValue> {
  const object = supplied === undefined ? {} : requireObject(supplied, path)
  const properties = schema?.properties ?? {}

  for (const key of Object.keys(object)) {
    if (!hasOwn(properties, key)) fail(`${path}.${key}`, '不支持的参数')
  }

  const result: Record<string, JsonValue> = {}
  for (const [name, property] of Object.entries(properties)) {
    const value = object[name]
    if (value === undefined) {
      if (property.default !== undefined) result[name] = property.default
      else if (property.required) fail(`${path}.${name}`, '缺少必填参数')
      continue
    }
    validateValue(value, property, `${path}.${name}`)
    result[name] = value
  }
  return result
}

export function normalizeProjectRoot(projectRoot: string): string {
  return normalize(resolve(projectRoot))
}

export function samePath(left: string, right: string, platform = process.platform): boolean {
  const normalizedLeft = normalize(resolve(left))
  const normalizedRight = normalize(resolve(right))
  return platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight
}

export function sameProjectRoot(left: string, right: string): boolean {
  return samePath(left, right)
}

export function projectKey(projectRoot: string): string {
  const normalized = normalizeProjectRoot(projectRoot)
  const label =
    basename(normalized)
      .normalize('NFKC')
      .replace(/[^\p{L}\p{N}._-]+/gu, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'project'
  const hash = createHash('sha256')
    .update(process.platform === 'win32' ? normalized.toLowerCase() : normalized)
    .digest('hex')
    .slice(0, 8)
  return `${label}-${hash}`
}

export function workspacePoolRoot(): string {
  return join(homedir(), 'pi-workspaces')
}

export function workspaceBaseRoot(projectRoot: string, poolRoot = workspacePoolRoot()): string {
  return join(poolRoot, projectKey(projectRoot))
}

export function createWorkspaceId(): string {
  return `ws-${randomBytes(6).toString('hex')}`
}

export function createAssignmentId(): string {
  return `as-${randomBytes(8).toString('hex')}`
}

export function assertWorkspaceId(id: string): void {
  if (!WORKSPACE_ID_PATTERN.test(id)) throw new WorkspaceError(`workspace ID 不合法：${id}`)
}

export function assertAssignmentId(id: string): void {
  if (!ASSIGNMENT_ID_PATTERN.test(id)) {
    throw new WorkspaceError(`assignment ID 不合法：${id}`)
  }
}

export function workspaceRoot(id: string, baseRoot: string): string {
  assertWorkspaceId(id)
  return join(baseRoot, id)
}

export function formatWorkspaceRef(workspaceId: string, assignmentId: string): string {
  assertWorkspaceId(workspaceId)
  assertAssignmentId(assignmentId)
  return `${workspaceId}@${assignmentId}`
}

export function parseWorkspaceRef(value: string): WorkspaceSelection {
  const parts = value.split('@')
  if (parts.length !== 2) throw new WorkspaceError(`workspace 引用不合法：${value}`)
  const [workspaceId, assignmentId] = parts
  assertWorkspaceId(workspaceId ?? '')
  assertAssignmentId(assignmentId ?? '')
  return { workspaceId: workspaceId!, assignmentId: assignmentId! }
}

export function restoreActiveSelection(
  entries: Array<{ type?: string; customType?: string; data?: unknown }>
): WorkspaceSelection | undefined {
  let result: WorkspaceSelection | null | undefined
  for (const entry of entries) {
    if (entry.type !== 'custom' || entry.customType !== SELECTION_ENTRY) continue
    if (!isObject(entry.data)) continue
    if (entry.data.workspaceId === null && entry.data.assignmentId === null) {
      result = null
      continue
    }
    if (typeof entry.data.workspaceId !== 'string' || typeof entry.data.assignmentId !== 'string') {
      continue
    }
    try {
      assertWorkspaceId(entry.data.workspaceId)
      assertAssignmentId(entry.data.assignmentId)
      result = {
        workspaceId: entry.data.workspaceId,
        assignmentId: entry.data.assignmentId
      }
    } catch {
      // Ignore malformed historical entries.
    }
  }
  return result ?? undefined
}

export function containsPath(base: string, target: string): boolean {
  const difference = relative(base, target)
  return (
    difference === '' ||
    (!difference.startsWith(`..${sep}`) && difference !== '..' && !isAbsolute(difference))
  )
}

async function inspectPath(path: string): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  try {
    return await lstat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

async function rejectLink(path: string, label: string): Promise<void> {
  const info = await inspectPath(path)
  if (
    info &&
    (info.isSymbolicLink() ||
      (process.platform === 'win32' &&
        (info as { isReparsePoint?: () => boolean }).isReparsePoint?.()))
  ) {
    throw new WorkspaceError(`${label} 不能是 symlink、junction 或 reparse point：${path}`)
  }
}

export async function ensureWorkspaceBase(
  projectRoot: string,
  poolRoot = workspacePoolRoot()
): Promise<string> {
  await mkdir(poolRoot, { recursive: true })
  await rejectLink(poolRoot, 'workspace pool')
  const baseRoot = workspaceBaseRoot(projectRoot, poolRoot)
  await mkdir(baseRoot, { recursive: true })
  await rejectLink(baseRoot, 'workspace project root')
  return baseRoot
}

export async function assertSafeWorkspacePaths(root: string, options: SafePaths): Promise<void> {
  const baseRoot = options.baseRoot
  if (!existsSync(baseRoot)) {
    if (options.requireRoot) throw new WorkspaceError(`工作区项目根目录不存在：${baseRoot}`)
    return
  }

  await rejectLink(baseRoot, 'workspace project root')
  const baseReal = await realpath(baseRoot)
  // 词法路径先互相比较，再校验真实路径，允许祖先目录为链接。
  if (!containsPath(resolve(baseRoot), resolve(root))) {
    throw new WorkspaceError(`workspace root 不在项目工作区目录内：${root}`)
  }

  if (!existsSync(root)) {
    if (options.requireRoot) throw new WorkspaceError(`工作区不存在：${root}`)
    return
  }

  await rejectLink(root, 'workspace root')
  const rootInfo = await stat(root)
  if (!rootInfo.isDirectory()) throw new WorkspaceError(`workspace root 必须是目录：${root}`)
  const rootReal = await realpath(root)
  if (!containsPath(baseReal, rootReal)) {
    throw new WorkspaceError(`workspace root 解析后逃离项目工作区目录：${root}`)
  }

  const metadataPath = join(root, WORKSPACE_METADATA_DIRECTORY)
  await rejectLink(metadataPath, 'workspace metadata directory')
  const metadataInfo = await inspectPath(metadataPath)
  if (metadataInfo && !metadataInfo.isDirectory()) {
    throw new WorkspaceError(`workspace metadata directory 必须是目录：${metadataPath}`)
  }
  await rejectLink(join(root, MARKER_FILE), 'workspace marker')
}

export async function resolveHandlerPath(projectRoot: string, handler: string): Promise<string> {
  const canonical = requireHandlerPath(handler, 'handler')
  const root = await realpath(projectRoot)
  const target = resolve(root, ...canonical.split('/'))
  if (!containsPath(root, target)) throw new WorkspaceError(`Handler 逃离项目根目录：${handler}`)
  await rejectLink(target, 'workspace handler')
  if (!existsSync(target)) throw new WorkspaceError(`Workspace Handler 不存在：${handler}`)
  const targetInfo = await stat(target)
  if (!targetInfo.isFile()) throw new WorkspaceError(`Workspace Handler 必须是文件：${handler}`)
  const targetReal = await realpath(target)
  if (!containsPath(root, targetReal))
    throw new WorkspaceError(`Handler 解析后逃离项目：${handler}`)
  return targetReal
}

function parseOperation(value: unknown, path: string): WorkspaceOperation {
  const object = requireObject(value, path)
  onlyKeys(object, ['command', 'startedAt', 'endedAt', 'result', 'summary', 'logPath'], path)

  const command = requireString(object.command, `${path}.command`)
  assertKebabKey(command, `${path}.command`)
  const startedAt = requireTimestamp(object.startedAt, `${path}.startedAt`)

  let endedAt: number | null
  if (object.endedAt === null) endedAt = null
  else endedAt = requireTimestamp(object.endedAt, `${path}.endedAt`)

  if (
    object.result !== null &&
    object.result !== 'success' &&
    object.result !== 'failed' &&
    object.result !== 'unknown'
  ) {
    fail(`${path}.result`, '必须是 success、failed、unknown 或 null')
  }
  if ((object.result === null) !== (endedAt === null)) {
    fail(path, '运行中记录必须同时使用 result=null 和 endedAt=null')
  }

  const operation: WorkspaceOperation = {
    command,
    startedAt,
    endedAt,
    result: object.result,
    logPath: requireString(object.logPath, `${path}.logPath`)
  }
  if (object.summary !== undefined) {
    operation.summary = requireString(object.summary, `${path}.summary`)
  }
  return operation
}

function parseOccupation(value: unknown, path: string): WorkspaceOccupation {
  const object = requireObject(value, path)
  onlyKeys(object, ['id', 'requirement', 'occupiedAt', 'sourceSessionId', 'operations'], path)

  const id = requireString(object.id, `${path}.id`)
  assertAssignmentId(id)
  const requirement = requireString(object.requirement, `${path}.requirement`).trim()
  if (requirement.length > 500) fail(`${path}.requirement`, '不能超过 500 个字符')
  if (!Array.isArray(object.operations)) fail(`${path}.operations`, '必须是数组')
  if (object.operations.length > MAX_OPERATIONS) {
    fail(`${path}.operations`, `最多保留 ${MAX_OPERATIONS} 条记录`)
  }

  const sourceSessionId =
    object.sourceSessionId === undefined
      ? undefined
      : requireString(object.sourceSessionId, `${path}.sourceSessionId`)
  return {
    id,
    requirement,
    occupiedAt: requireTimestamp(object.occupiedAt, `${path}.occupiedAt`),
    ...(sourceSessionId ? { sourceSessionId } : {}),
    operations: object.operations.map((operation, index) =>
      parseOperation(operation, `${path}.operations[${index}]`)
    )
  }
}

export async function readMarker(
  root: string,
  options: SafePaths
): Promise<WorkspaceMarker | undefined> {
  await assertSafeWorkspacePaths(root, {
    ...options,
    requireRoot: options.requireRoot ?? true
  })
  const path = join(root, MARKER_FILE)
  if (!existsSync(path)) return undefined

  let raw: unknown
  try {
    raw = JSON.parse(await readFile(path, 'utf8'))
  } catch {
    throw new WorkspaceError(`${path}: 无法解析 JSON marker`)
  }

  const object = requireObject(raw, path)
  onlyKeys(
    object,
    ['schema', 'definition', 'projectRoot', 'provisionParameters', 'status', 'occupation'],
    path
  )
  if (object.schema !== MARKER_SCHEMA && object.schema !== LEGACY_MARKER_SCHEMA) {
    fail(`${path}.schema`, `必须是 ${LEGACY_MARKER_SCHEMA} 或 ${MARKER_SCHEMA}`)
  }

  const definition = requireString(object.definition, `${path}.definition`)
  assertKebabKey(definition, `${path}.definition`)
  const projectRoot = requireString(object.projectRoot, `${path}.projectRoot`)
  const provisionParameters = requireObject(
    object.provisionParameters,
    `${path}.provisionParameters`
  )
  if (!isJsonValue(provisionParameters)) {
    fail(`${path}.provisionParameters`, '必须是 JSON 对象')
  }

  const base: WorkspaceMarkerBase = {
    schema: MARKER_SCHEMA,
    definition,
    projectRoot,
    provisionParameters: provisionParameters as Record<string, JsonValue>
  }

  if (object.status === 'available') {
    if (object.occupation !== null) fail(`${path}.occupation`, 'available 时必须为 null')
    return { ...base, status: 'available', occupation: null }
  }
  if (object.status === 'occupied') {
    return {
      ...base,
      status: 'occupied',
      occupation: parseOccupation(object.occupation, `${path}.occupation`)
    }
  }
  fail(`${path}.status`, '仅支持 available、occupied')
}

export async function writeMarker(
  root: string,
  marker: WorkspaceMarker,
  options: SafePaths
): Promise<void> {
  await assertSafeWorkspacePaths(root, { ...options, requireRoot: true })
  await mkdir(join(root, WORKSPACE_METADATA_DIRECTORY), { recursive: true })
  await assertSafeWorkspacePaths(root, { ...options, requireRoot: true })
  const path = join(root, MARKER_FILE)
  const temporary = join(root, `${MARKER_FILE}.${randomBytes(4).toString('hex')}.tmp`)
  try {
    await writeFile(temporary, `${JSON.stringify(marker, null, 2)}\n`, 'utf8')
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true })
  }
}

export function markerBase(options: {
  projectRoot: string
  definition: Definition
  root: string
  provisionParameters: Record<string, JsonValue>
}): WorkspaceMarkerBase {
  return {
    schema: MARKER_SCHEMA,
    definition: options.definition.id,
    projectRoot: normalizeProjectRoot(options.projectRoot),
    provisionParameters: options.provisionParameters
  }
}

export function availableMarker(base: WorkspaceMarkerBase): AvailableWorkspaceMarker {
  return { ...base, status: 'available', occupation: null }
}

export function occupiedMarker(
  base: WorkspaceMarkerBase,
  occupation: WorkspaceOccupation
): OccupiedWorkspaceMarker {
  return { ...base, status: 'occupied', occupation }
}

export function assertMarkerIdentity(marker: WorkspaceMarker, expected: WorkspaceMarkerBase): void {
  if (
    marker.schema !== expected.schema ||
    marker.definition !== expected.definition ||
    !sameProjectRoot(marker.projectRoot, expected.projectRoot) ||
    !isDeepStrictEqual(marker.provisionParameters, expected.provisionParameters)
  ) {
    throw new WorkspaceError(
      'workspace marker 身份冲突（schema、definition、projectRoot 或 provisionParameters 不匹配）'
    )
  }
}

export function assertDefinitionCompatibility(
  record: WorkspaceRecord,
  definition: Definition
): void {
  const provisionParameters = validateParameters(
    definition.provision.parameters,
    record.marker.provisionParameters,
    'marker.provisionParameters'
  )
  if (!isDeepStrictEqual(provisionParameters, record.marker.provisionParameters)) {
    throw new WorkspaceError('workspace 配置已漂移，需要恢复 definition 或重建工作区')
  }
}

export async function verifyWorkspace(
  record: WorkspaceRecord,
  definition: Definition,
  baseRoot: string
): Promise<void> {
  assertDefinitionCompatibility(record, definition)
  await assertSafeWorkspacePaths(record.root, { baseRoot, requireRoot: true })
}

export async function listWorkspaces(
  projectRoot: string,
  baseRoot: string
): Promise<WorkspaceRecord[]> {
  if (!existsSync(baseRoot)) return []
  await rejectLink(baseRoot, 'workspace project root')

  const records: WorkspaceRecord[] = []
  for (const item of await readdir(baseRoot, { withFileTypes: true })) {
    if (!item.isDirectory() || item.isSymbolicLink() || !WORKSPACE_ID_PATTERN.test(item.name)) {
      continue
    }
    const root = join(baseRoot, item.name)
    try {
      const marker = await readMarker(root, { baseRoot })
      if (marker && sameProjectRoot(marker.projectRoot, projectRoot)) {
        records.push({ id: item.name, root, marker })
      }
    } catch {
      // Invalid directories are excluded from the reusable pool.
    }
  }
  return records.sort((left, right) => left.id.localeCompare(right.id))
}

export async function getWorkspace(
  projectRoot: string,
  id: string,
  baseRoot: string
): Promise<WorkspaceRecord> {
  const root = workspaceRoot(id, baseRoot)
  await assertSafeWorkspacePaths(root, { baseRoot, requireRoot: true })
  const marker = await readMarker(root, { baseRoot })
  if (!marker) throw new WorkspaceError(`工作区不存在或缺少 marker：${id}`)
  if (!sameProjectRoot(marker.projectRoot, projectRoot)) {
    throw new WorkspaceError(`工作区 ${id} 属于其他项目`)
  }
  return { id, root, marker }
}

export function createOccupation(
  requirementInput: string,
  sourceSessionId: string
): WorkspaceOccupation {
  const requirement = requirementInput.trim()
  if (!requirement) throw new WorkspaceError('requirement 必须是非空字符串')
  if (requirement.length > 500) throw new WorkspaceError('requirement 不能超过 500 个字符')
  const source = sourceSessionId.trim()
  if (!source) throw new WorkspaceError('sourceSessionId 必须是非空字符串')
  return {
    id: createAssignmentId(),
    requirement,
    occupiedAt: Date.now(),
    sourceSessionId: source,
    operations: []
  }
}

function trimOperations(operations: WorkspaceOperation[]): WorkspaceOperation[] {
  const result = [...operations]
  while (result.length > MAX_OPERATIONS) {
    const removable = result.findIndex((item) => item.result !== null)
    if (removable < 0) break
    result.splice(removable, 1)
  }
  return result
}

export function appendRunningOperation(
  occupation: WorkspaceOccupation,
  operation: Omit<WorkspaceOperation, 'endedAt' | 'result'>
): WorkspaceOccupation {
  return {
    ...occupation,
    operations: trimOperations([
      ...occupation.operations,
      { ...operation, endedAt: null, result: null } satisfies WorkspaceOperation
    ])
  }
}

export function appendCompletedOperation(
  occupation: WorkspaceOccupation,
  operation: WorkspaceOperation & {
    endedAt: number
    result: Exclude<WorkspaceOperation['result'], null>
  }
): WorkspaceOccupation {
  return {
    ...occupation,
    operations: trimOperations([...occupation.operations, operation])
  }
}

export function reconcileInterruptedOperations(
  occupation: WorkspaceOccupation,
  endedAt = Date.now()
): WorkspaceOccupation {
  return {
    ...occupation,
    operations: occupation.operations.map((operation) =>
      operation.result === null
        ? {
            ...operation,
            endedAt,
            result: 'unknown',
            summary: operation.summary ?? '进程结束前未收到明确结果'
          }
        : operation
    )
  }
}

export function finishLastOperation(
  occupation: WorkspaceOccupation,
  result: Exclude<WorkspaceOperation['result'], null>,
  summary?: string
): WorkspaceOccupation {
  const operations = occupation.operations.map((operation, index) => {
    if (index !== occupation.operations.length - 1) return operation
    return {
      ...operation,
      endedAt: Date.now(),
      result,
      ...(summary ? { summary } : {})
    }
  })
  return { ...occupation, operations }
}

export function commandInput(options: {
  command: string
  projectRoot: string
  record: WorkspaceRecord
  parameters: Record<string, JsonValue>
}): WorkspaceCommandInput {
  if (options.record.marker.status !== 'occupied') {
    throw new WorkspaceError('只有 occupied 工作区才能构造命令输入')
  }
  return {
    schema: COMMAND_INPUT_SCHEMA,
    command: options.command,
    project: { root: normalizeProjectRoot(options.projectRoot) },
    workspace: {
      id: options.record.id,
      root: options.record.root,
      definition: options.record.marker.definition,
      provisionParameters: options.record.marker.provisionParameters
    },
    occupation: {
      id: options.record.marker.occupation.id,
      requirement: options.record.marker.occupation.requirement,
      occupiedAt: options.record.marker.occupation.occupiedAt
    },
    parameters: options.parameters
  }
}

export async function readCommandResult(path: string): Promise<WorkspaceCommandResult> {
  let raw: unknown
  try {
    raw = JSON.parse(await readFile(path, 'utf8'))
  } catch {
    throw new WorkspaceError(`命令结果无法解析：${path}`)
  }
  const object = requireObject(raw, path)
  onlyKeys(object, ['schema', 'success', 'summary', 'error'], path)
  if (object.schema !== COMMAND_RESULT_SCHEMA) {
    fail(`${path}.schema`, `必须是 ${COMMAND_RESULT_SCHEMA}`)
  }
  if (object.success === true) {
    const result: WorkspaceCommandResult = {
      schema: COMMAND_RESULT_SCHEMA,
      success: true
    }
    if (object.summary !== undefined) {
      const summary = requireString(object.summary, `${path}.summary`)
      if (summary.length > 4000) fail(`${path}.summary`, '不能超过 4000 个字符')
      result.summary = summary
    }
    if (object.error !== undefined) fail(`${path}.error`, '成功结果不能包含 error')
    return result
  }
  if (object.success === false) {
    if (object.summary !== undefined) fail(`${path}.summary`, '失败结果不能包含 summary')
    return {
      schema: COMMAND_RESULT_SCHEMA,
      success: false,
      error: requireString(object.error, `${path}.error`)
    }
  }
  fail(`${path}.success`, '必须明确为 true 或 false')
}

export async function createCommandRunPaths(
  projectRoot: string,
  protectedLogPaths: readonly string[] = []
): Promise<{
  directory: string
  inputPath: string
  outputPath: string
  logPath: string
}> {
  const runRoot = join(projectRoot, 'temp', 'pi', 'workspace')
  await mkdir(runRoot, { recursive: true })
  await pruneCommandRuns(runRoot, protectedLogPaths)

  const directory = join(
    runRoot,
    `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomBytes(3).toString('hex')}`
  )
  await mkdir(directory, { recursive: false })
  return {
    directory,
    inputPath: join(directory, 'input.json'),
    outputPath: join(directory, 'output.json'),
    logPath: join(directory, 'command.log')
  }
}

async function pruneCommandRuns(
  runRoot: string,
  protectedLogPaths: readonly string[],
  keepUnprotected = 100
): Promise<void> {
  const protectedDirectories = protectedLogPaths.map((path) => dirname(path))
  const entries = await Promise.all(
    (await readdir(runRoot, { withFileTypes: true }))
      .filter((item) => item.isDirectory())
      .map(async (item) => ({
        path: join(runRoot, item.name),
        modified: (await stat(join(runRoot, item.name))).mtimeMs
      }))
  )
  const unprotected = entries
    .filter((entry) => !protectedDirectories.some((directory) => samePath(directory, entry.path)))
    .sort((left, right) => right.modified - left.modified)
  await Promise.all(
    unprotected
      .slice(keepUnprotected)
      .map((entry) => rm(entry.path, { recursive: true, force: true }))
  )
}

export async function writeCommandInput(path: string, input: WorkspaceCommandInput): Promise<void> {
  await writeFile(path, `${JSON.stringify(input, null, 2)}\n`, 'utf8')
}

export async function collectProtectedLogPaths(
  projectRoot: string,
  baseRoot: string
): Promise<string[]> {
  const records = await listWorkspaces(projectRoot, baseRoot)
  return records.flatMap((record) =>
    record.marker.status === 'occupied'
      ? record.marker.occupation.operations.map((operation) => operation.logPath)
      : []
  )
}
