import 'server-only'

import { join } from 'node:path'
import { z } from 'zod'
import { readL4PiTsxImport } from './l4-pi-tsx-loader'
import { runL4PiRunnerProcess } from './l4-pi-runner-process'

const L4_PI_PLUGIN_CAPABILITY_PROBE_TIMEOUT_MS = 30_000
const L4_PI_PLUGIN_CAPABILITY_PROBE_MAX_OUTPUT_BYTES = 4 * 1024 * 1024
const L4_PI_PLUGIN_CAPABILITY_PROBE_RESULT_PREFIX = '__PI_DESK_PLUGIN_CAPABILITIES__'

const L4PiPluginCapabilityTextSchema = z.string()
const L4PiPluginCapabilityNamedDescriptionSchema = z
  .object({
    name: z.string(),
    description: z.string().nullable()
  })
  .strict()

const L4PiPluginCapabilitySnapshotSchema = z
  .object({
    packages: z.array(
      z
        .object({
          source: z.string(),
          error: z.string().nullable(),
          extensions: z.array(
            z
              .object({
                path: z.string(),
                events: z.array(
                  z.object({ name: z.string(), count: z.number().int().positive() }).strict()
                ),
                commands: z.array(L4PiPluginCapabilityNamedDescriptionSchema),
                shortcuts: z.array(
                  z
                    .object({
                      shortcut: z.string(),
                      description: z.string().nullable()
                    })
                    .strict()
                ),
                flags: z.array(
                  z
                    .object({
                      name: z.string(),
                      type: z.enum(['boolean', 'string']),
                      description: z.string().nullable(),
                      default: z.union([z.boolean(), z.string(), z.null()])
                    })
                    .strict()
                ),
                messageRenderers: z.array(z.string()),
                entryRenderers: z.array(z.string())
              })
              .strict()
          ),
          tools: z.array(
            z
              .object({
                name: z.string(),
                label: L4PiPluginCapabilityTextSchema,
                state: z.enum(['active', 'inactive', 'shadowed']),
                description: L4PiPluginCapabilityTextSchema,
                parameters: z.record(z.string(), z.json()),
                promptSnippet: L4PiPluginCapabilityTextSchema.nullable(),
                promptSnippetDetail: L4PiPluginCapabilityTextSchema.nullable(),
                promptGuidelines: z.array(L4PiPluginCapabilityTextSchema),
                promptGuidelineCount: z.number().int().nonnegative(),
                promptGuidelinePreview: L4PiPluginCapabilityTextSchema.nullable()
              })
              .strict()
          ),
          skills: z.array(
            z
              .object({
                name: z.string(),
                description: z.string(),
                path: z.string(),
                filePath: z.string(),
                modelVisible: z.boolean()
              })
              .strict()
          ),
          prompts: z.array(
            z
              .object({
                name: z.string(),
                description: z.string(),
                path: z.string(),
                filePath: z.string()
              })
              .strict()
          ),
          themes: z.array(
            z
              .object({
                name: z.string(),
                path: z.string()
              })
              .strict()
          ),
          providers: z.array(
            z
              .object({
                name: z.string(),
                kind: z.enum(['config', 'native'])
              })
              .strict()
          )
        })
        .strict()
    ),
    loadError: z.string().nullable()
  })
  .strict()

export type L4PiPluginCapabilitySnapshot = z.infer<typeof L4PiPluginCapabilitySnapshotSchema>
export type L4PiPluginPackageCapabilities = L4PiPluginCapabilitySnapshot['packages'][number]

export async function runL4PiPluginCapabilityProbe(
  cwd: string,
  agentDir: string
): Promise<L4PiPluginCapabilitySnapshot> {
  const tsxImport = readL4PiTsxImport()
  const runnerPath = join(
    process.cwd(),
    'src',
    'server',
    'l4_foundation',
    'pi',
    'l4-pi-plugin-capability-probe-runner.mts'
  )

  const { stdout, stderr, code } = await runL4PiRunnerProcess({
    args: ['--conditions=react-server', '--import', tsxImport, runnerPath],
    agentDir,
    env: { PI_DESK_PLUGIN_CAPABILITY_AGENT_DIR: agentDir, PI_DESK_PLUGIN_CAPABILITY_CWD: cwd },
    maxOutputBytes: L4_PI_PLUGIN_CAPABILITY_PROBE_MAX_OUTPUT_BYTES,
    timeoutMs: L4_PI_PLUGIN_CAPABILITY_PROBE_TIMEOUT_MS,
    timeoutError: () => new Error('插件能力盘点超时'),
    cleanupError: (output, error) =>
      new Error(`${output}\n能力盘点进程树清理失败`, { cause: error })
  })
  if (code !== 0) throw new Error(stderr.trim() || `插件能力盘点进程退出码 ${code ?? 'null'}`)
  const marker = stdout.lastIndexOf(L4_PI_PLUGIN_CAPABILITY_PROBE_RESULT_PREFIX)
  if (marker < 0) throw new Error('插件能力盘点没有返回有效结果')
  const line = stdout
    .slice(marker + L4_PI_PLUGIN_CAPABILITY_PROBE_RESULT_PREFIX.length)
    .split(/\r?\n/, 1)[0]
  return L4PiPluginCapabilitySnapshotSchema.parse(JSON.parse(line))
}
