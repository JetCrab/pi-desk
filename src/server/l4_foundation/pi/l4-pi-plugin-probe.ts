import 'server-only'

import { join } from 'node:path'
import { z } from 'zod'
import type { L4PiPluginRuntimeDiagnostics } from './l4-pi-plugin-owner-runtime'
import { readL4PiTsxImport } from './l4-pi-tsx-loader'
import { runL4PiRunnerProcess } from './l4-pi-runner-process'

const L4_PI_PLUGIN_PROBE_TIMEOUT_MS = 30_000
const L4_PI_PLUGIN_PROBE_MAX_OUTPUT_BYTES = 1024 * 1024
const L4_PI_PLUGIN_PROBE_RESULT_PREFIX = '__PI_DESK_PLUGIN_PROBE__'
const L4PiPluginRuntimeDiagnosticsSchema = z
  .object({
    packages: z.array(
      z
        .object({
          source: z.string(),
          packageName: z.string().nullable(),
          version: z.string().nullable(),
          pluginName: z.string().nullable(),
          status: z.enum(['ready', 'failed']),
          error: z
            .object({
              phase: z.enum(['package', 'entry', 'setup', 'resources', 'resolve']),
              message: z.string()
            })
            .strict()
            .nullable()
        })
        .strict()
    ),
    loadError: z.string().nullable()
  })
  .strict()

export async function runL4PiPluginProbe(
  cwd: string,
  agentDir: string,
  checkNative = false
): Promise<L4PiPluginRuntimeDiagnostics> {
  const tsxImport = readL4PiTsxImport()
  const runnerPath = join(
    process.cwd(),
    'src',
    'server',
    'l4_foundation',
    'pi',
    'l4-pi-plugin-probe-runner.mts'
  )

  // 独立 Node 进程不经过 Next 编译，需要显式启用 server-only 的服务端导出。
  const { stdout, stderr, code } = await runL4PiRunnerProcess({
    args: ['--conditions=react-server', '--import', tsxImport, runnerPath],
    agentDir,
    env: {
      PI_DESK_PLUGIN_PROBE_AGENT_DIR: agentDir,
      PI_DESK_PLUGIN_PROBE_CWD: cwd,
      PI_DESK_PLUGIN_PROBE_NATIVE: checkNative ? '1' : undefined
    },
    maxOutputBytes: L4_PI_PLUGIN_PROBE_MAX_OUTPUT_BYTES,
    timeoutMs: L4_PI_PLUGIN_PROBE_TIMEOUT_MS,
    timeoutError: () => new Error('插件预检超时'),
    cleanupError: (output, error) =>
      new Error(`${output}\n插件预检进程树清理失败`, { cause: error })
  })
  if (code !== 0) throw new Error(stderr.trim() || `插件预检进程退出码 ${code ?? 'null'}`)
  const marker = stdout.lastIndexOf(L4_PI_PLUGIN_PROBE_RESULT_PREFIX)
  if (marker < 0) throw new Error('插件预检没有返回有效结果')
  const line = stdout.slice(marker + L4_PI_PLUGIN_PROBE_RESULT_PREFIX.length).split(/\r?\n/, 1)[0]
  return L4PiPluginRuntimeDiagnosticsSchema.parse(JSON.parse(line)) as L4PiPluginRuntimeDiagnostics
}
