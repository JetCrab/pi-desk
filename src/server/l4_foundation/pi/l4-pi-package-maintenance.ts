import 'server-only'

import { join } from 'node:path'
import type { L4PiDeskPackageMaintenanceRequest } from './l4-pi-desk-process-control'
import { readL4PiTsxImport } from './l4-pi-tsx-loader'
import { runL4PiRunnerProcess } from './l4-pi-runner-process'

const L4_PI_PACKAGE_MAINTENANCE_MAX_OUTPUT_BYTES = 1024 * 1024
const L4_PI_PACKAGE_MAINTENANCE_PUBLIC_ERROR_CHARS = 4000

export type L4PiPackageMaintenanceFailureKind = 'locked' | 'failed'

export class L4PiPackageMaintenanceError extends Error {
  constructor(
    readonly kind: L4PiPackageMaintenanceFailureKind,
    readonly output: string,
    readonly exitCode: number | null
  ) {
    super(
      output.slice(-L4_PI_PACKAGE_MAINTENANCE_PUBLIC_ERROR_CHARS) ||
        `Pi Package 命令退出码 ${exitCode ?? 'null'}`
    )
    this.name = 'L4PiPackageMaintenanceError'
  }
}

export function classifyL4PiPackageMaintenanceFailure(
  output: string
): L4PiPackageMaintenanceFailureKind {
  const normalized = output.toLowerCase()
  if (
    normalized.includes('ebusy') ||
    normalized.includes('etxtbsy') ||
    normalized.includes('resource busy') ||
    normalized.includes('being used by another process') ||
    normalized.includes('used by another process') ||
    normalized.includes('process cannot access the file because it is being used')
  ) {
    return 'locked'
  }
  const permissionError =
    normalized.includes('eperm') ||
    normalized.includes('eacces') ||
    normalized.includes('operation not permitted')
  const fileReplacement = /\b(unlink|rename|rmdir|rimraf|remove|cleanup)\b/.test(normalized)
  return permissionError && fileReplacement ? 'locked' : 'failed'
}

export async function runL4PiPackageMaintenance(input: {
  maintenance: L4PiDeskPackageMaintenanceRequest
  agentDir: string
  cwd: string
}): Promise<void> {
  const tsxImport = readL4PiTsxImport()
  const runnerPath = join(
    process.cwd(),
    'src',
    'server',
    'l4_foundation',
    'pi',
    'l4-pi-package-maintenance-runner.mts'
  )

  const { stdout, stderr, code } = await runL4PiRunnerProcess({
    args: [
      '--import',
      tsxImport,
      runnerPath,
      input.maintenance.action,
      input.maintenance.source,
      ...(input.maintenance.registry ? [input.maintenance.registry] : [])
    ],
    agentDir: input.agentDir,
    env: { PI_DESK_PACKAGE_MAINTENANCE_CWD: input.cwd },
    maxOutputBytes: L4_PI_PACKAGE_MAINTENANCE_MAX_OUTPUT_BYTES,
    timeoutMs: 120_000,
    timeoutError: () =>
      new L4PiPackageMaintenanceError(
        'failed',
        '包维护超过120秒，已停止；结果未确认，请检查配置后手动处理',
        null
      ),
    cleanupError: (_output, error) =>
      new L4PiPackageMaintenanceError(
        'failed',
        `维护进程树未确认释放：${error instanceof Error ? error.message : String(error)}`,
        null
      )
  })
  if (code === 0) return
  const output = (stderr || stdout).trim()
  throw new L4PiPackageMaintenanceError(classifyL4PiPackageMaintenanceFailure(output), output, code)
}
