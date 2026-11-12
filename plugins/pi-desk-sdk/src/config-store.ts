import { dirname } from 'node:path'
import { parseDocument } from 'yaml'
import { z } from 'zod'
import type { PluginConfig } from './config-api.js'
import { getConfigPath } from './config.ts'
import {
  ensureStorageDirectory,
  readStorageFile,
  withStorageLock,
  writeStorageFile
} from './config-storage.ts'
import { configValueLocations, getConfigLocation, setConfigLocation } from './config-paths.ts'
import {
  decryptConfigValue,
  encryptConfigValue,
  hasEncryptedConfigValue,
  isEncryptedConfigValue,
  loadConfigKey,
  type ConfigKeyOptions
} from './config-encryption.ts'
import { normalizePluginIdentifier, type PluginJsonObject } from './shared.ts'

const dictionary = z.record(z.string(), z.json())
const maxConfigBytes = 8 * 1024 * 1024

export interface ConfigStoreOptions extends ConfigKeyOptions {
  agentDir?: string
  /** 宿主 Owner 失效后禁止新操作及尚未发布的写入。 */
  assertActive?: () => void
}

export function getUnifiedConfigPath(agentDir?: string): string {
  return getConfigPath('pi-desk.yaml', agentDir)
}

function readDocument(path: string): {
  previous: Buffer | null
  document: ReturnType<typeof parseDocument>
  root: PluginJsonObject
} {
  const previous = readStorageFile(path, maxConfigBytes)
  const document = parseDocument(previous?.toString('utf8') ?? '{}\n', {
    uniqueKeys: true,
    schema: 'core'
  })
  if (document.errors.length) throw new Error(`统一配置 YAML 无法解析：${path}`)
  const root = dictionary.parse(document.toJS({ maxAliasCount: 100 }) ?? {})
  for (const namespace of ['pi-desk', 'plugins']) {
    if (Object.hasOwn(root, namespace)) dictionary.parse(root[namespace])
  }
  return { previous, document, root }
}

/** 宿主同步启动读取普通配置；插件业务使用四接口，不从这里解密。 */
export function readConfigSection(
  namespace: 'pi-desk' | 'plugins',
  name: string,
  agentDir?: string
): PluginJsonObject {
  const { root } = readDocument(getUnifiedConfigPath(agentDir))
  return dictionary.parse(dictionary.parse(root[namespace] ?? {})[name] ?? {})
}

/** 供宿主装配与原生绑定使用，业务插件直接使用绑定后的 plugin.config。 */
export function bindConfigStore(
  namespace: 'pi-desk' | 'plugins',
  name: string,
  options: ConfigStoreOptions = {}
): PluginConfig {
  name = normalizePluginIdentifier(name, 'pluginName')
  const path = getUnifiedConfigPath(options.agentDir)
  const assertActive = (): void => options.assertActive?.()

  async function access<T>(
    action: (
      state: ReturnType<typeof readDocument>,
      key: (required: boolean) => Promise<Buffer>,
      assertCurrent: () => void
    ) => Promise<T>
  ): Promise<T> {
    assertActive()
    ensureStorageDirectory(dirname(path))
    return withStorageLock(path, async (assertLocked) => {
      const assertCurrent = (): void => {
        assertLocked()
        assertActive()
      }
      assertCurrent()
      const state = readDocument(path)
      let loadedKey: Buffer | undefined
      try {
        return await action(
          state,
          async (required) => {
            loadedKey ??= await loadConfigKey(
              path,
              required || hasEncryptedConfigValue(state.root),
              options,
              assertCurrent
            )
            assertCurrent()
            return loadedKey
          },
          assertCurrent
        )
      } finally {
        loadedKey?.fill(0)
      }
    })
  }

  return {
    async encrypt(value): Promise<string> {
      return access(async (_state, key) => encryptConfigValue(value, await key(false)))
    },
    async decrypt(value): Promise<ReturnType<typeof decryptConfigValue>> {
      return access(async (_state, key) => decryptConfigValue(value, await key(true)))
    },
    async set(conf, encryptPaths = []): Promise<void> {
      const next = dictionary.parse(conf)
      const locations = configValueLocations(next, encryptPaths)
      await access(async (state, key, assertCurrent) => {
        for (const location of locations) {
          setConfigLocation(
            location,
            encryptConfigValue(getConfigLocation(location), await key(false))
          )
        }
        state.document.setIn([namespace, name], next)
        const content = Buffer.from(state.document.toString())
        if (content.byteLength > maxConfigBytes) throw new Error('统一配置文件不能超过 8 MiB')
        assertCurrent()
        writeStorageFile(path, content, state.previous)
      })
    },
    async get(decryptPaths = []): Promise<PluginJsonObject> {
      return access(async ({ root }, key) => {
        const section = dictionary.parse(root[namespace] ?? {})
        const conf = dictionary.parse(section[name] ?? {})
        for (const location of configValueLocations(conf, decryptPaths)) {
          const value = getConfigLocation(location)
          if (isEncryptedConfigValue(value)) {
            setConfigLocation(location, decryptConfigValue(value, await key(true)))
          }
        }
        return conf
      })
    }
  }
}
