import assert from 'node:assert/strict'
import Module from 'node:module'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { PiDeskPluginFacade } from '@jetcrab/pi-desk-sdk/entry'

type ModuleRuntime = {
  _load: (request: string, parent: unknown, isMain: boolean) => unknown
}

type TiboPlugin = {
  name: string
  setup(plugin: PiDeskPluginFacade): Promise<{ dispose: () => Promise<void> }>
}

const moduleRuntime = Module as unknown as ModuleRuntime

test('插件启动只读写最新分离配置，保留全部旧文件', async (context) => {
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR
  const agentDir = await mkdtemp(join(tmpdir(), 'pi-desk-tibo-migration-'))
  context.after(async () => {
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir
    await rm(agentDir, { recursive: true, force: true })
  })
  process.env.PI_CODING_AGENT_DIR = agentDir

  const previousPath = join(agentDir, 'pi-super-tibo-monitor.json')
  const previousContent = JSON.stringify({
    settings: { enabled: false, intervalSeconds: 60, retentionCount: 100, model: null },
    records: []
  })
  const oldContent = '{旧混合配置不应解析}'
  await writeFile(previousPath, oldContent, 'utf8')
  await writeFile(join(agentDir, 'pi-desk-tibo-monitor.json'), oldContent, 'utf8')
  await mkdir(join(agentDir, 'config'), { recursive: true })
  await mkdir(join(agentDir, 'pi-desk'), { recursive: true })
  await writeFile(
    join(agentDir, 'config', 'pi-desk-tibo-monitor.json'),
    JSON.stringify({ settings: JSON.parse(previousContent).settings })
  )
  await writeFile(join(agentDir, 'pi-desk', 'tibo-monitor.json'), JSON.stringify({ records: [] }))

  const originalLoad = moduleRuntime._load
  const loadOriginal = originalLoad.bind(moduleRuntime)
  moduleRuntime._load = (request, parent, isMain) => {
    if (request === '@earendil-works/pi-coding-agent') {
      return { getAgentDir: () => process.env.PI_CODING_AGENT_DIR }
    }
    if (request === '@jetcrab/pi-desk-sdk/entry') {
      return { definePiDeskPlugin: (definition: unknown) => definition }
    }
    if (request === '@jetcrab/pi-desk-sdk/session') {
      return { PluginMethodError: class extends Error {} }
    }
    if (request === './l4-tibo-model.js') {
      return {
        TiboModels: class {
          async list() {
            return []
          }
        }
      }
    }
    return loadOriginal(request, parent, isMain)
  }

  let plugin: TiboPlugin
  try {
    plugin = (await import(new URL('../src/l2-tibo-entry.ts', import.meta.url).href))
      .default as TiboPlugin
  } finally {
    moduleRuntime._load = originalLoad
  }

  const facade = {
    host: {
      settings: {
        getSnapshot: () => ({ region: { locale: 'zh-CN', timeZone: 'Asia/Shanghai' } }),
        subscribe: () => () => undefined
      }
    },
    registerMethod() {},
    registerBrowserEntry() {},
    setState() {},
    notifications: {
      publish() {
        return 'notification'
      },
      update() {},
      delete() {}
    }
  } as unknown as PiDeskPluginFacade
  const session = await plugin.setup(facade)
  context.after(() => session.dispose())
  const currentPath = join(agentDir, 'config', 'pi-desk-tibo-monitor.json')
  const dataPath = join(agentDir, 'pi-desk', 'tibo-monitor.json')

  assert.equal(plugin.name, 'tibo-monitor')
  assert.deepEqual(JSON.parse(await readFile(currentPath, 'utf8')), {
    settings: JSON.parse(previousContent).settings
  })
  assert.deepEqual(JSON.parse(await readFile(dataPath, 'utf8')), {
    records: [],
    analysisRegion: { locale: 'zh-CN', timeZone: 'Asia/Shanghai' }
  })
  assert.equal(await readFile(previousPath, 'utf8'), oldContent)
  assert.equal(await readFile(join(agentDir, 'pi-desk-tibo-monitor.json'), 'utf8'), oldContent)
})
