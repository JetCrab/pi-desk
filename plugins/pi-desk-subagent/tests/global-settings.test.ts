import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { saveGlobalSubagentSettings } from '../src/global-settings'
import { listGlobalSubagentSettings } from '../src/agent-config'

test('独立配置保存不重写原生settings的注释、换行及未知字段', async (context) => {
  const runs = fileURLToPath(new URL('../../../temp/run/subagent-config/', import.meta.url))
  await mkdir(runs, { recursive: true })
  const agentDir = await mkdtemp(join(resolve(runs), 'native-bytes-'))
  const previous = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = agentDir
  context.after(async () => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previous
    await rm(agentDir, { recursive: true, force: true })
  })
  const nativePath = join(agentDir, 'settings.json')
  const native =
    '{\r\n  // 原生及未知配置\r\n  "defaultProvider": "test-provider",\r\n  "agents": { "explore": { "disabled": true } },\r\n  "unknown": { "spacing" : [1, 2] }\r\n}\r\n'
  await writeFile(nativePath, native)
  assert.equal(
    listGlobalSubagentSettings().find((item) => item.name === 'explore')?.disabled,
    false
  )
  await saveGlobalSubagentSettings({
    agents: [{ name: 'explore', model: '', thinking: null, disabled: true }]
  })
  assert.equal(await readFile(nativePath, 'utf8'), native)
  const settings = JSON.parse(
    await readFile(join(agentDir, 'config', 'pi-desk-subagent.json'), 'utf8')
  )
  assert.deepEqual(settings.agents.explore, { disabled: true })
})

test('全局子代理设置仅修改目标字段并拒绝无效模型和重复名称', async () => {
  const agentDir = await mkdtemp(join(tmpdir(), 'pi-desk-subagent-settings-'))
  const settingsPath = join(agentDir, 'config', 'pi-desk-subagent.json')
  const nativePath = join(agentDir, 'settings.json')
  const originalNative =
    '{ "customGlobalKey": { "keep": true }, "agents": { "explore": { "disabled": false } } }'
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR
  const previousOffline = process.env.PI_OFFLINE
  process.env.PI_CODING_AGENT_DIR = agentDir
  process.env.PI_OFFLINE = '1'

  try {
    await mkdir(join(agentDir, 'config'), { recursive: true })
    await writeFile(nativePath, originalNative)
    await writeFile(
      settingsPath,
      JSON.stringify({
        agents: {
          explore: {
            model: 'old-provider/old-model',
            thinking: 'medium',
            disabled: false,
            customAgentKey: 'preserve'
          },
          dev: { model: 'other-provider/other-model', customAgentKey: 'untouched' }
        }
      }),
      'utf8'
    )

    const result = await saveGlobalSubagentSettings({
      agents: [{ name: 'explore', model: '', thinking: null, disabled: true }]
    })
    assert.equal(await readFile(nativePath, 'utf8'), originalNative)
    const saved = JSON.parse(
      await readFile(join(agentDir, 'config', 'pi-desk-subagent.json'), 'utf8')
    ) as {
      agents: Record<string, Record<string, unknown>>
    }
    assert.deepEqual(saved.agents.explore, { disabled: true, customAgentKey: 'preserve' })
    assert.deepEqual(saved.agents.dev, {
      model: 'other-provider/other-model',
      customAgentKey: 'untouched'
    })
    assert.deepEqual(
      result.agents.find((agent) => agent.name === 'explore'),
      {
        name: 'explore',
        model: '',
        thinking: null,
        disabled: true
      }
    )

    const unchanged = await readFile(settingsPath, 'utf8')
    await assert.rejects(
      saveGlobalSubagentSettings({
        agents: [
          {
            name: 'explore',
            model: 'missing-provider/missing-model',
            thinking: null,
            disabled: false
          }
        ]
      }),
      /模型当前不可用/
    )
    await assert.rejects(
      saveGlobalSubagentSettings({
        agents: [
          { name: 'explore', model: '', thinking: null, disabled: true },
          { name: 'explore', model: '', thinking: null, disabled: true }
        ]
      }),
      /子代理设置参数无效/
    )
    assert.equal(await readFile(settingsPath, 'utf8'), unchanged)
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir
    if (previousOffline === undefined) delete process.env.PI_OFFLINE
    else process.env.PI_OFFLINE = previousOffline
    await rm(agentDir, { recursive: true, force: true })
  }
})
