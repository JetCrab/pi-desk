import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { discoverSubagentConfigs } from '../src/agent-config'

async function writeAgent(
  path: string,
  input: { description: string; tools: string; model?: string; thinking?: string; body: string }
): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true })
  const optional = [
    input.model ? `model: ${input.model}` : '',
    input.thinking ? `thinking: ${input.thinking}` : ''
  ]
    .filter(Boolean)
    .join('\n')
  await writeFile(
    path,
    `---\ndescription: ${input.description}\ntools: ${input.tools}${optional ? `\n${optional}` : ''}\n---\n\n${input.body}\n`,
    'utf8'
  )
}

test('默认加载包内置 Agent', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-desk-subagent-builtin-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const agentDir = join(root, 'agent')
  const cwd = join(root, 'project')
  await mkdir(cwd, { recursive: true })

  const result = discoverSubagentConfigs({
    cwd,
    projectTrusted: false,
    agentDir
  })

  assert.deepEqual([...result.configs.keys()], ['dev', 'explore', 'research'])
  for (const config of result.configs.values()) {
    assert.equal(config.model, undefined, `${config.name} 默认不指定模型`)
  }
  const explore = result.configs.get('explore')
  assert.ok(explore)
  assert.equal(
    explore.description,
    '快速初步探索现有代码库的执行路径、架构分层和依赖关系，为开发提供线索。仅限代码分析，不用于开发完成后的代码审查或网络调研。使用能力较弱的模型，核心代码逻辑可由主代理复核。'
  )
  assert.deepEqual(explore.tools, ['read', 'grep', 'find', 'ls'])
  assert.equal(explore.thinking, 'medium')
  assert.match(explore.systemPrompt, /主要逻辑、关键位置和待主代理复核项/)
  assert.match(explore.systemPrompt, /## 输出格式/)

  const research = result.configs.get('research')
  assert.ok(research)
  assert.equal(
    research.description,
    '专注网络调研，检索外部网页、GitHub 项目与缓存证据，用于技术选型和外部源码调研；不承担开发实现、错误排查或代码审查。'
  )
  assert.deepEqual(research.tools, [
    'research_delegate',
    'external_research',
    'read',
    'grep',
    'find',
    'ls'
  ])
  assert.equal(research.thinking, 'medium')
  assert.match(research.systemPrompt, /外部研究的范围判断、证据获取和结果汇总/)
  assert.match(research.systemPrompt, /GitHub 项目/)
  assert.match(research.systemPrompt, /不承担开发实现、错误排查或代码审查/)
  assert.deepEqual(result.diagnostics, [])
})

test('agents 下的 disabled 会隐藏对应 Agent', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-desk-subagent-disabled-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const agentDir = join(root, 'agent')
  const cwd = join(root, 'project')
  await writeAgent(join(agentDir, 'agents', 'explore.md'), {
    description: '探索',
    tools: 'read',
    body: 'Explore Prompt'
  })
  await writeAgent(join(agentDir, 'agents', 'research.md'), {
    description: '研究',
    tools: 'read',
    body: 'Research Prompt'
  })
  await writeFile(
    join(agentDir, 'settings.json'),
    JSON.stringify({ agents: { research: { disabled: true } } }),
    'utf8'
  )
  await mkdir(cwd, { recursive: true })

  const result = discoverSubagentConfigs({
    cwd,
    projectTrusted: false,
    agentDir,
    builtinAgentsDir: null
  })

  assert.deepEqual([...result.configs.keys()], ['explore'])
  assert.deepEqual(result.diagnostics, [])
})

test('受信任项目 Agent 覆盖全局同名配置，模型设置按项目优先', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-desk-subagent-config-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const agentDir = join(root, 'agent')
  const projectRoot = join(root, 'project')
  const nestedCwd = join(projectRoot, 'src', 'nested')

  await writeAgent(join(agentDir, 'agents', 'explore.md'), {
    description: '全局探索',
    tools: 'read, grep, find, ls',
    model: 'global/explore',
    thinking: 'medium',
    body: '全局 Explore Prompt'
  })
  await writeAgent(join(agentDir, 'agents', 'research.md'), {
    description: '全局研究',
    tools: 'external_research, read, grep, find, ls',
    body: '全局 Research Prompt'
  })
  await writeFile(
    join(agentDir, 'settings.json'),
    JSON.stringify({ agents: { research: { model: 'global/research', thinking: 'high' } } }),
    'utf8'
  )
  await writeAgent(join(projectRoot, '.pi', 'agents', 'explore.md'), {
    description: '项目探索',
    tools: 'read, grep',
    body: '项目 Explore Prompt'
  })
  await writeFile(
    join(projectRoot, '.pi', 'settings.json'),
    JSON.stringify({ agents: { explore: { model: 'project/explore', thinking: 'low' } } }),
    'utf8'
  )
  await mkdir(nestedCwd, { recursive: true })

  const trusted = discoverSubagentConfigs({
    cwd: nestedCwd,
    projectTrusted: true,
    agentDir,
    builtinAgentsDir: null
  })
  assert.deepEqual([...trusted.configs.keys()], ['explore', 'research'])
  assert.deepEqual(trusted.configs.get('explore'), {
    name: 'explore',
    description: '项目探索',
    tools: ['read', 'grep'],
    model: 'project/explore',
    thinking: 'low',
    systemPrompt: '项目 Explore Prompt'
  })
  assert.equal(trusted.configs.get('research')?.description, '全局研究')
  assert.equal(trusted.configs.get('research')?.systemPrompt, '全局 Research Prompt')
  assert.equal(trusted.configs.get('research')?.model, 'global/research')
  assert.equal(trusted.configs.get('research')?.thinking, 'high')
  assert.deepEqual(trusted.diagnostics, [])

  const untrusted = discoverSubagentConfigs({
    cwd: nestedCwd,
    projectTrusted: false,
    agentDir,
    builtinAgentsDir: null
  })
  assert.equal(untrusted.configs.get('explore')?.systemPrompt, '全局 Explore Prompt')
})

test('内置、全局和项目 Agent 按优先级覆盖，项目禁用配置覆盖全局', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-desk-subagent-scope-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const agentDir = join(root, 'agent')
  const builtinAgentsDir = join(root, 'builtin-agents')
  const projectRoot = join(root, 'project')
  const cwd = join(projectRoot, 'src')

  await writeAgent(join(builtinAgentsDir, 'shared.md'), {
    description: '内置',
    tools: 'read',
    model: 'builtin/model',
    body: '内置 Prompt'
  })
  await writeAgent(join(agentDir, 'agents', 'shared.md'), {
    description: '全局',
    tools: 'grep',
    body: '全局 Prompt'
  })
  await writeAgent(join(agentDir, 'agents', 'global-only.md'), {
    description: '全局独有',
    tools: 'read',
    body: '全局独有 Prompt'
  })
  await writeAgent(join(projectRoot, '.pi', 'agents', 'shared.md'), {
    description: '项目',
    tools: 'find',
    body: '项目 Prompt'
  })
  await writeAgent(join(projectRoot, '.pi', 'agents', 'project-only.md'), {
    description: '项目独有',
    tools: 'ls',
    body: '项目独有 Prompt'
  })
  await writeFile(
    join(agentDir, 'settings.json'),
    JSON.stringify({
      agents: {
        shared: { model: 'global/model', thinking: 'medium', disabled: true },
        'global-only': { disabled: true }
      }
    }),
    'utf8'
  )
  await writeFile(
    join(projectRoot, '.pi', 'settings.json'),
    JSON.stringify({
      agents: {
        shared: { model: 'project/model', thinking: 'high', disabled: false },
        'project-only': { disabled: true }
      }
    }),
    'utf8'
  )
  await mkdir(cwd, { recursive: true })

  const result = discoverSubagentConfigs({
    cwd,
    projectTrusted: true,
    agentDir,
    builtinAgentsDir
  })

  assert.deepEqual([...result.configs.keys()], ['shared'])
  assert.deepEqual(result.configs.get('shared'), {
    name: 'shared',
    description: '项目',
    tools: ['find'],
    model: 'project/model',
    thinking: 'high',
    systemPrompt: '项目 Prompt'
  })
  assert.equal(result.configs.has('global-only'), false)
  assert.equal(result.configs.has('project-only'), false)
  assert.deepEqual(result.diagnostics, [])
})

test('缺少 description 的 Agent 不注册', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-desk-subagent-description-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const agentDir = join(root, 'agent')
  const cwd = join(root, 'project')
  await mkdir(join(agentDir, 'agents'), { recursive: true })
  await mkdir(cwd, { recursive: true })
  await writeFile(
    join(agentDir, 'agents', 'explore.md'),
    '---\ntools: read\n---\n\nExplore Prompt\n',
    'utf8'
  )

  const result = discoverSubagentConfigs({
    cwd,
    projectTrusted: false,
    agentDir,
    builtinAgentsDir: null
  })

  assert.equal(result.configs.has('explore'), false)
  assert.match(result.diagnostics[0] ?? '', /must define a description/)
})

test('无效项目覆盖不会静默退回全局 Agent', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-desk-subagent-invalid-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const agentDir = join(root, 'agent')
  const projectRoot = join(root, 'project')
  await writeAgent(join(agentDir, 'agents', 'explore.md'), {
    description: '全局探索',
    tools: 'read',
    body: '全局 Prompt'
  })
  await writeAgent(join(projectRoot, '.pi', 'agents', 'explore.md'), {
    description: '项目探索',
    tools: 'bad tool',
    body: '项目 Prompt'
  })

  const result = discoverSubagentConfigs({
    cwd: projectRoot,
    projectTrusted: true,
    agentDir,
    builtinAgentsDir: null
  })
  assert.equal(result.configs.has('explore'), false)
  assert.match(result.diagnostics[0] ?? '', /invalid tool names/)
})
