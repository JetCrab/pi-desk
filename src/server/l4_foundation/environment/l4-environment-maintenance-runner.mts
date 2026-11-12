import { getAgentDir } from '@earendil-works/pi-coding-agent'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import {
  L4EnvironmentMaintenanceRequestSchema,
  updateL4EnvironmentOperation,
  type L4EnvironmentMaintenanceRequest
} from './l4-environment-operations'
import { collectL4Environment, readL4EnvironmentBounded } from './l4-environment-collect'
import { writeEnvironmentArchive } from './l4-environment-archive'
import { applyL4EnvironmentImport, inspectL4EnvironmentArchive } from './l4-environment-import'
import { L4EnvironmentOperationSchema } from './l4-environment-state'
import { mapEnvironmentPath } from './l4-environment-paths'
import { isL4EnvironmentGitSource, installL4EnvironmentPackage } from './l4-environment-packages'
import { L4EnvironmentValidationError } from './l4-environment-error'
import {
  getL4EnvironmentOperationRoot,
  isL4EnvironmentCommitRecorded,
  recoverL4EnvironmentBeforeRuntime
} from './l4-environment-maintenance'

/** 仅受管父进程在旧进程树退出后调用；stdin 传密码，argv/日志/operation.json 均无密码。 */
export async function runL4EnvironmentMaintenance(
  request: L4EnvironmentMaintenanceRequest
): Promise<void> {
  if (request.agentDir !== getAgentDir()) throw new Error('维护 AgentDir 与当前隔离环境不一致')
  const directory = join(getL4EnvironmentOperationRoot(request.agentDir), request.id)
  // 同时处理上次崩溃现场；当前 operation 尚未进入 running。
  await recoverL4EnvironmentBeforeRuntime(request.agentDir, undefined, request.id)
  const accepted = L4EnvironmentOperationSchema.parse(
    JSON.parse(await readFile(join(directory, 'operation.json'), 'utf8'))
  )
  if (accepted.id !== request.id || accepted.kind !== request.kind || accepted.status !== 'pending')
    throw new Error('离线请求未处于已提交待执行状态，不重放既有操作')
  await updateL4EnvironmentOperation(directory, {
    status: 'running',
    phase: request.kind === 'export' ? 'archiving-offline' : 'applying-offline',
    error: null
  })
  console.info('[Pi Desk][Environment] 开始离线维护', { phase: request.kind })
  try {
    if (request.kind === 'export') {
      const collection = await collectL4Environment(request)
      await writeEnvironmentArchive({
        outputPath: join(directory, 'archive.enc'),
        password: request.password,
        entries: collection.entries()
      })
      await updateL4EnvironmentOperation(directory, {
        status: 'ready',
        phase: 'archive-ready',
        warnings: collection.manifest.warnings
      })
      console.info('[Pi Desk][Environment] 离线归档完成', {
        files: collection.manifest.files.length
      })
    } else {
      const preview = await inspectL4EnvironmentArchive({
        id: request.id,
        archivePath: join(directory, 'archive.enc'),
        password: request.password
      })
      const warnings = await applyL4EnvironmentImport({
        directory,
        agentDir: request.agentDir,
        archivePath: join(directory, 'archive.enc'),
        password: request.password,
        manifest: preview.manifest,
        selection: request.selection
      })
      // 包只在配置项 settings.json 被选中时安装；纯会话/插件数据导入不改变配置或安装环境。
      const selectedSettings = preview.manifest.files.filter(
        (file) =>
          request.selection.selectedIds.includes(file.id) &&
          file.path === 'settings.json' &&
          (file.base === 'agent' || file.base === 'project')
      )
      if (selectedSettings.length) {
        for (const [packageIndex, pkg] of preview.manifest.packages.entries()) {
          const label =
            pkg.name && /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(pkg.name)
              ? pkg.name
              : `第${packageIndex + 1}个Pi包`
          if (
            !selectedSettings.some((file) =>
              pkg.projectCwd
                ? file.base === 'project' && file.sourceCwd === pkg.projectCwd
                : file.base === 'agent'
            )
          )
            continue
          const mappings = [
            ...request.selection.mappings.map(({ from, to }) => ({ source: from, target: to })),
            { source: preview.manifest.sourceAgentDir, target: request.agentDir }
          ]
          const cwd = pkg.projectCwd
            ? (mapEnvironmentPath(
                pkg.projectCwd,
                mappings,
                preview.manifest.sourcePlatform === 'win32' ? 'win32' : 'posix',
                process.platform === 'win32' ? 'win32' : 'posix'
              ) ?? (preview.manifest.sourcePlatform === process.platform ? pkg.projectCwd : null))
            : request.cwd
          if (!cwd) {
            warnings.push(`${label}缺少项目目标目录映射，未执行替代安装。`)
            continue
          }
          let installSource: string
          if (pkg.localPath) {
            const mapped = mapEnvironmentPath(
              pkg.localPath,
              [
                ...request.selection.mappings.map(({ from, to }) => ({ source: from, target: to })),
                { source: preview.manifest.sourceAgentDir, target: request.agentDir }
              ],
              preview.manifest.sourcePlatform === 'win32' ? 'win32' : 'posix',
              process.platform === 'win32' ? 'win32' : 'posix'
            )
            const target =
              mapped ??
              (preview.manifest.sourcePlatform === process.platform ? pkg.localPath : null)
            if (
              !target ||
              !(await stat(target).then(
                (info) => info.isDirectory() || info.isFile(),
                () => false
              ))
            ) {
              warnings.push(`${label}的本地源码未选择恢复或缺少目标映射，未执行替代安装。`)
              continue
            }
            installSource = target
            warnings.push(
              '本地Pi包源码已定位；node_modules未复制，依赖需按包原始声明准备，未自行执行私有安装流程。'
            )
          } else if (isL4EnvironmentGitSource(pkg.source)) {
            const pinned = pkg.installSource
            if (!pinned || !/@[0-9a-f]{40,64}$/i.test(pinned)) {
              warnings.push(`${label}的Git来源未锁定实际提交，未自动拉取、升级或替换。`)
              continue
            }
            installSource = pinned
          } else if (
            pkg.source.startsWith('npm:') &&
            pkg.name &&
            pkg.version &&
            /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(pkg.version)
          ) {
            installSource = `npm:${pkg.name}@${pkg.version}`
          } else {
            warnings.push(`${label}缺少可确认的固定来源，未执行自动升级或替代安装。`)
            continue
          }
          try {
            await installL4EnvironmentPackage({
              source: installSource,
              cwd,
              agentDir: request.agentDir,
              project: Boolean(pkg.projectCwd),
              ...(pkg.registry ? { registry: pkg.registry } : {})
            })
          } catch {
            warnings.push(
              `${label}按原固定来源重装失败；文件已提交，未静默升级，请核对实际安装结果。`
            )
          }
        }
      }
      await updateL4EnvironmentOperation(directory, {
        status: 'completed',
        phase: warnings.some((warning) => warning.startsWith('桌面配置已暂存'))
          ? 'desktop-staged-restart-required'
          : 'import-completed',
        warnings: [...preview.manifest.warnings, ...warnings]
      })
      console.info('[Pi Desk][Environment] 离线导入完成', {
        files: request.selection.selectedIds.length
      })
    }
  } catch (error) {
    const committed = request.kind === 'import' && (await isL4EnvironmentCommitRecorded(directory))
    const previous = JSON.parse(await readFile(join(directory, 'operation.json'), 'utf8')) as {
      phase: string
      warnings: string[]
    }
    await updateL4EnvironmentOperation(directory, {
      status: committed ? 'completed' : 'failed',
      phase: committed
        ? 'import-files-committed'
        : previous.phase === 'import-rolled-back'
          ? 'import-rolled-back'
          : 'maintenance-failed',
      ...(committed
        ? {
            warnings: [
              ...previous.warnings,
              '文件已提交，但后续维护步骤未全部完成；请核对包安装和桌面状态，不自动重放。'
            ]
          }
        : {}),
      error: committed
        ? null
        : error instanceof L4EnvironmentValidationError
          ? error.message
          : previous.phase === 'import-rolled-back'
            ? '离线维护失败，本次宿主原件已恢复；未自动重放'
            : '离线维护失败，提交结果未确认；启动前检查事务事实，不自动重放'
    })
    // 只输出阶段，不转发可能含原始配置/秘密的底层错误文本。
    throw new Error('离线环境维护失败，请读取操作结果并检查保留现场')
  }
}

const request = L4EnvironmentMaintenanceRequestSchema.parse(
  JSON.parse((await readL4EnvironmentBounded(process.stdin, 1024 * 1024)).toString('utf8'))
)
void runL4EnvironmentMaintenance(request).then(
  () => process.exit(0),
  () => {
    console.error('[Pi Desk][Environment] 离线维护失败')
    process.exit(1)
  }
)
