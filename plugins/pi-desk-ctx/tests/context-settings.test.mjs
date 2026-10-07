import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const require = createRequire(import.meta.url)
const workspaceNodeModules = join(process.cwd(), 'node_modules')

function packageEntry(packageName) {
  const path = join(workspaceNodeModules, ...packageName.split('/'), 'dist/index.js')
  if (!existsSync(path)) {
    throw new Error(`请从包含 ${packageName} 的项目根目录运行测试：${path}`)
  }
  return path
}

const { createJiti } = require(require.resolve('jiti', { paths: [process.cwd()] }))
const jiti = createJiti(import.meta.url, {
  alias: {
    '@earendil-works/pi-coding-agent': packageEntry('@earendil-works/pi-coding-agent')
  },
  tsconfigPaths: true
})
const {
  findMatchingContextIgnoreRule,
  matchesContextIgnoreRule,
  parseContextIgnoreSettings,
  selectContextIgnoreProfile
} = await jiti.import(new URL('../src/context-settings.ts', import.meta.url).pathname)
const { defaultContextIgnoreSettingsPath, readContextIgnoreSettings, writeContextIgnoreSettings } =
  await jiti.import(new URL('../src/context-settings-store.ts', import.meta.url).pathname)

function settingsFixture() {
  return {
    enabled: true,
    profiles: [
      {
        keepRecentUserTurns: 3,
        processTokenBudget: 40_000,
        rules: [{ projectedTokensAtMost: 100_000 }]
      },
      {
        maxContextTokens: 600_000,
        checkpointTokens: 480_000,
        keepRecentUserTurns: 3,
        processTokenBudget: 40_000,
        rules: [{ currentTokensAtLeast: 400_000 }]
      },
      {
        maxContextTokens: 400_000,
        keepRecentUserTurns: 2,
        processTokenBudget: 20_000,
        rules: [{ currentTokensAtLeast: 250_000, projectedTokensAtMost: 50_000 }]
      }
    ]
  }
}

test('模型配置按上限升序匹配且通用配置固定最后', () => {
  const settings = parseContextIgnoreSettings(settingsFixture())
  assert.deepEqual(
    settings.profiles.map((profile) => profile.maxContextTokens),
    [400_000, 600_000, undefined]
  )
  assert.equal(selectContextIgnoreProfile(settings, 350_000).maxContextTokens, 400_000)
  assert.equal(selectContextIgnoreProfile(settings, 500_000).maxContextTokens, 600_000)
  assert.equal(selectContextIgnoreProfile(settings, 1_000_000).maxContextTokens, undefined)
  assert.equal(selectContextIgnoreProfile(settings, 0).maxContextTokens, undefined)
})

test('单条规则允许只启用一个绝对 Token 条件', () => {
  assert.equal(matchesContextIgnoreRule({ currentTokensAtLeast: 400_000 }, 450_000, 300_000), true)
  assert.equal(matchesContextIgnoreRule({ currentTokensAtLeast: 400_000 }, 350_000, 20_000), false)
  assert.equal(matchesContextIgnoreRule({ projectedTokensAtMost: 50_000 }, 100_000, 40_000), true)
  assert.equal(
    findMatchingContextIgnoreRule(
      [
        { currentTokensAtLeast: 500_000, projectedTokensAtMost: 150_000 },
        { projectedTokensAtMost: 50_000 }
      ],
      420_000,
      40_000
    ),
    1
  )
})

test('配置拒绝无条件规则、重复上限和缺少通用配置', () => {
  assert.throws(
    () =>
      parseContextIgnoreSettings({
        enabled: true,
        profiles: [
          {
            keepRecentUserTurns: 3,
            processTokenBudget: 40_000,
            rules: [{}]
          }
        ]
      }),
    /至少需要一个判断条件/
  )
  assert.throws(
    () =>
      parseContextIgnoreSettings({
        enabled: true,
        profiles: [
          ...settingsFixture().profiles,
          {
            maxContextTokens: 400_000,
            keepRecentUserTurns: 3,
            processTokenBudget: 40_000,
            rules: []
          }
        ]
      }),
    /模型窗口上限不能重复/
  )
  assert.throws(
    () =>
      parseContextIgnoreSettings({
        enabled: true,
        profiles: settingsFixture().profiles.filter(
          (profile) => profile.maxContextTokens !== undefined
        )
      }),
    /通用配置/
  )
})

test('旧配置文件首次访问复制到 Pi Desk 路径并保留原文件', async (context) => {
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR
  const agentDir = await mkdtemp(join(tmpdir(), 'pi-desk-ctx-migration-'))
  context.after(async () => {
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir
    await rm(agentDir, { recursive: true, force: true })
  })
  process.env.PI_CODING_AGENT_DIR = agentDir

  const previousPath = join(agentDir, 'pi-super-ctx.json')
  const previousContent = JSON.stringify(settingsFixture())
  await writeFile(previousPath, previousContent, 'utf8')

  const currentPath = defaultContextIgnoreSettingsPath()
  assert.equal(currentPath, join(agentDir, 'pi-desk-ctx.json'))
  assert.equal(await readFile(currentPath, 'utf8'), previousContent)
  assert.equal(await readFile(previousPath, 'utf8'), previousContent)

  const currentContent = JSON.stringify({ ...settingsFixture(), enabled: false })
  await writeFile(currentPath, currentContent, 'utf8')
  assert.equal(defaultContextIgnoreSettingsPath(), currentPath)
  assert.equal(await readFile(currentPath, 'utf8'), currentContent)
})

test('配置文件保存实际 Token 并在读取时保持归一化顺序', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-desk-ctx-settings-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'pi-desk-ctx.json')

  const written = await writeContextIgnoreSettings(settingsFixture(), path)
  const restored = await readContextIgnoreSettings(path)
  assert.deepEqual(restored, written)
  assert.deepEqual(
    restored.profiles.map((profile) => profile.maxContextTokens),
    [400_000, 600_000, undefined]
  )

  const raw = JSON.parse(await readFile(path, 'utf8'))
  assert.equal(raw.profiles[0].maxContextTokens, 400_000)
  assert.equal(raw.profiles[0].processTokenBudget, 20_000)

  const replaced = await writeContextIgnoreSettings({ ...settingsFixture(), enabled: false }, path)
  assert.equal(replaced.enabled, false)
  assert.equal((await readContextIgnoreSettings(path)).enabled, false)
})
