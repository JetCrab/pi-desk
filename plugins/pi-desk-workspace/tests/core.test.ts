import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { access, mkdir, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import {
  COMMAND_RESULT_SCHEMA,
  MARKER_FILE,
  WORKSPACE_METADATA_DIRECTORY,
  WorkspaceError,
  appendRunningOperation,
  assertDefinitionCompatibility,
  assertSafeWorkspacePaths,
  availableMarker,
  createCommandRunPaths,
  createOccupation,
  finishLastOperation,
  formatWorkspaceRef,
  markerBase,
  occupiedMarker,
  parseConfig,
  parseWorkspaceRef,
  projectKey,
  readCommandResult,
  readMarker,
  reconcileInterruptedOperations,
  restoreActiveSelection,
  validateParameters,
  verifyWorkspace,
  writeMarker,
  type Definition
} from '../src/core.js'

const tempRoot = resolve(process.cwd(), '../../temp/pi/workspace/test-core-v3')
afterEach(async () => rm(tempRoot, { recursive: true, force: true }))

const yaml = `schema: pi.workspace/v3
definitions:
  demo:
    description: Demo workspace
    provision:
      description: Prepare workspace
      parameters:
        type: object
        additionalProperties: false
        properties:
          runtime:
            type: string
            required: false
            default: node-22
            enum: [node-20, node-22]
      handler: .pi/workspace/provision.mjs
      timeoutSeconds: 30
    commands:
      commit:
        description: Commit workspace
        from: [occupied]
        onSuccess: occupied
        handler: .pi/workspace/commands/commit.mjs
      reset:
        description: Reset workspace
        from: [occupied]
        onSuccess: available
        parameters:
          type: object
          additionalProperties: false
          properties:
            force:
              type: boolean
              required: false
              default: false
        handler: .pi/workspace/commands/reset.mjs
`

function definition(): Definition {
  return parseConfig(yaml, 'workspace.yml').definitions.demo!
}

test('v3 配置只接受 Node Handler、状态转换和严格参数', () => {
  const config = parseConfig(yaml, 'workspace.yml')
  assert.equal(config.definitions.demo?.commands.reset?.onSuccess, 'available')
  assert.deepEqual(validateParameters(config.definitions.demo?.provision.parameters, {}), {
    runtime: 'node-22'
  })
  assert.deepEqual(validateParameters(config.definitions.demo?.commands.reset?.parameters, {}), {
    force: false
  })
  assert.throws(
    () =>
      parseConfig(
        yaml.replace('    provision:', '    entry: app\n    provision:'),
        'workspace.yml'
      ),
    /entry.*不支持的字段/
  )

  assert.throws(
    () =>
      parseConfig(
        yaml.replace('handler: .pi/workspace/provision.mjs', 'handler: ../x.mjs'),
        'workspace.yml'
      ),
    /\.pi\/workspace/
  )
  assert.throws(
    () => parseConfig(yaml.replace('from: \[occupied\]', 'from: [ready]'), 'workspace.yml'),
    /available、occupied/
  )
  assert.throws(
    () => parseConfig(yaml.replace('onSuccess: occupied', 'onSuccess: finished'), 'workspace.yml'),
    /available、occupied、removed/
  )
  assert.throws(
    () =>
      parseConfig(
        yaml.replace(
          '      handler: .pi/workspace/provision.mjs',
          '      steps: []\n      handler: .pi/workspace/provision.mjs'
        ),
        'workspace.yml'
      ),
    /steps/
  )
})

test('项目 Key 稳定且物理目录不使用需求名称', () => {
  const project = join(tempRoot, 'example-project')
  const first = projectKey(project)
  const second = projectKey(project)
  assert.equal(first, second)
  assert.match(first, /^example-project-[a-f0-9]{8}$/)
})

test('Marker 使用 available/occupied 判别状态并记录当前命令', async () => {
  const baseRoot = join(tempRoot, 'base')
  const root = join(baseRoot, 'ws-123456789abc')
  await mkdir(root, { recursive: true })

  const base = markerBase({
    projectRoot: tempRoot,
    definition: definition(),
    root,
    provisionParameters: { runtime: 'node-22' }
  })
  await writeMarker(root, availableMarker(base), { baseRoot })
  assert.equal((await readMarker(root, { baseRoot }))?.status, 'available')

  let occupation = createOccupation('示例任务', 'session-123')
  occupation = appendRunningOperation(occupation, {
    command: 'commit',
    startedAt: 100,
    logPath: join(tempRoot, 'command.log')
  })
  occupation = finishLastOperation(occupation, 'success', '提交完成')
  const occupied = occupiedMarker(base, occupation)
  await writeMarker(root, occupied, { baseRoot })

  const restored = await readMarker(root, { baseRoot })
  assert.equal(restored?.status, 'occupied')
  assert.equal(restored?.occupation?.sourceSessionId, 'session-123')
  assert.equal(restored?.occupation?.operations[0]?.summary, '提交完成')
  const record = { id: 'ws-123456789abc', root, marker: occupied }
  assert.doesNotThrow(() => assertDefinitionCompatibility(record, definition()))
  await assert.doesNotReject(() => verifyWorkspace(record, definition(), baseRoot))
  await assert.rejects(
    () => verifyWorkspace(record, definition(), join(tempRoot, 'wrong-base')),
    /工作区项目根目录不存在/
  )
  assert.throws(
    () =>
      assertDefinitionCompatibility(
        {
          ...record,
          marker: { ...occupied, provisionParameters: { runtime: 'node-18' } }
        },
        definition()
      ),
    /marker\.provisionParameters\.runtime.*enum 中的值/
  )

  await writeFile(
    join(root, MARKER_FILE),
    JSON.stringify({ ...availableMarker(base), occupation }),
    'utf8'
  )
  await assert.rejects(() => readMarker(root, { baseRoot }), /available 时必须为 null/)
})

test('进程中断的运行中 Operation 收敛为结果未知', () => {
  let occupation = createOccupation('中断测试', 'session-123')
  occupation = appendRunningOperation(occupation, {
    command: 'verify',
    startedAt: 100,
    logPath: join(tempRoot, 'verify.log')
  })
  const reconciled = reconcileInterruptedOperations(occupation, 200)
  assert.equal(reconciled.sourceSessionId, 'session-123')
  assert.deepEqual(reconciled.operations[0], {
    command: 'verify',
    startedAt: 100,
    endedAt: 200,
    result: 'unknown',
    summary: '进程结束前未收到明确结果',
    logPath: join(tempRoot, 'verify.log')
  })
})

test('workspaceRef 绑定 assignment 并从最后选择记录恢复', () => {
  const ref = formatWorkspaceRef('ws-123456789abc', 'as-1234567890abcdef')
  assert.equal(ref, 'ws-123456789abc@as-1234567890abcdef')
  assert.deepEqual(parseWorkspaceRef(ref), {
    workspaceId: 'ws-123456789abc',
    assignmentId: 'as-1234567890abcdef'
  })
  assert.deepEqual(
    restoreActiveSelection([
      {
        type: 'custom',
        customType: 'workspace-selection-v2',
        data: { workspaceId: 'ws-123456789abc', assignmentId: 'as-1234567890abcdef' }
      },
      {
        type: 'custom',
        customType: 'workspace-selection-v2',
        data: { workspaceId: null, assignmentId: null }
      }
    ]),
    undefined
  )
})

test('workspace root 和隐藏元数据目录不能使用 symlink', async (t) => {
  const baseRoot = join(tempRoot, 'base')
  const root = join(baseRoot, 'ws-123456789abc')
  const outside = join(tempRoot, 'outside')
  await mkdir(baseRoot, { recursive: true })
  await mkdir(outside, { recursive: true })

  try {
    await symlink(outside, root, 'dir')
  } catch {
    t.skip('当前系统不允许创建 symlink')
    return
  }
  await assert.rejects(
    () => assertSafeWorkspacePaths(root, { baseRoot, requireRoot: true }),
    /workspace root/
  )

  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  await symlink(outside, join(root, WORKSPACE_METADATA_DIRECTORY), 'dir')
  await assert.rejects(
    () => assertSafeWorkspacePaths(root, { baseRoot, requireRoot: true }),
    /metadata directory/
  )
})

test('父目录为链接时仍可读写工作区，但不能越过项目工作区目录', async (t) => {
  const physical = join(tempRoot, 'physical')
  const alias = join(tempRoot, 'alias')
  await mkdir(physical, { recursive: true })
  try {
    await symlink(physical, alias, process.platform === 'win32' ? 'junction' : 'dir')
  } catch (error) {
    if (!['EPERM', 'EACCES', 'ENOSYS'].includes((error as NodeJS.ErrnoException).code ?? '')) {
      throw error
    }
    t.skip('当前系统不允许创建目录链接')
    return
  }

  const baseRoot = join(alias, 'pool')
  const root = join(baseRoot, 'ws-123456789abc')
  await mkdir(root, { recursive: true })
  const marker = availableMarker(
    markerBase({
      projectRoot: tempRoot,
      definition: definition(),
      root,
      provisionParameters: { runtime: 'node-22' }
    })
  )
  await writeMarker(root, marker, { baseRoot })
  assert.deepEqual(await readMarker(root, { baseRoot }), marker)
  await assert.doesNotReject(() =>
    assertSafeWorkspacePaths(join(baseRoot, 'missing'), { baseRoot })
  )
  await assert.rejects(
    () => assertSafeWorkspacePaths(join(alias, 'outside'), { baseRoot }),
    /workspace root 不在项目工作区目录内/u
  )

  const outside = join(tempRoot, 'outside')
  await mkdir(join(outside, 'ws-123456789abc'), { recursive: true })
  await symlink(
    outside,
    join(baseRoot, 'redirect'),
    process.platform === 'win32' ? 'junction' : 'dir'
  )
  await assert.rejects(
    () =>
      assertSafeWorkspacePaths(join(baseRoot, 'redirect', 'ws-123456789abc'), {
        baseRoot,
        requireRoot: true
      }),
    /workspace root 解析后逃离项目工作区目录/u
  )
})

test('日志清理保留被引用的日志并按平台处理路径大小写', async () => {
  const project = join(tempRoot, 'log-project')
  const runRoot = join(project, 'temp', 'pi', 'workspace')
  const protectedDirectory = join(runRoot, 'old-protected')
  const disposableDirectory = join(runRoot, 'old-unprotected')
  await mkdir(protectedDirectory, { recursive: true })
  await mkdir(disposableDirectory)
  const protectedLog = join(protectedDirectory, 'command.log')
  await writeFile(protectedLog, '仍被操作记录引用的日志\n', 'utf8')
  await utimes(protectedDirectory, 1, 1)
  await utimes(disposableDirectory, 2, 2)
  await Promise.all(
    Array.from({ length: 100 }, (_, index) =>
      mkdir(join(runRoot, `recent-${index}`), { recursive: true })
    )
  )

  await createCommandRunPaths(project, [
    process.platform === 'win32' ? join(runRoot, 'OLD-PROTECTED', 'command.log') : protectedLog
  ])
  assert.equal(await readFile(protectedLog, 'utf8'), '仍被操作记录引用的日志\n')
  await assert.rejects(access(disposableDirectory), { code: 'ENOENT' })
})

test('命令结果必须明确 success 并符合固定 Schema', async () => {
  const path = join(tempRoot, 'output.json')
  await mkdir(tempRoot, { recursive: true })
  await writeFile(
    path,
    JSON.stringify({ schema: COMMAND_RESULT_SCHEMA, success: true, summary: '完成' }),
    'utf8'
  )
  assert.deepEqual(await readCommandResult(path), {
    schema: COMMAND_RESULT_SCHEMA,
    success: true,
    summary: '完成'
  })

  await writeFile(path, JSON.stringify({ success: true }), 'utf8')
  await assert.rejects(() => readCommandResult(path), /schema/)
  await writeFile(path, JSON.stringify({ schema: COMMAND_RESULT_SCHEMA, success: false }), 'utf8')
  await assert.rejects(() => readCommandResult(path), /error/)
})

test('WorkspaceError 保留字段定位', () => {
  const error = new WorkspaceError('bad', 'parameters.scope')
  assert.equal(error.field, 'parameters.scope')
})
