import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { saveGlobalSubagentSettings } from '../src/global-settings'

test('全局子代理设置仅修改目标字段并拒绝无效模型和重复名称', async () => {
  const agentDir = await mkdtemp(join(tmpdir(), 'pi-desk-subagent-settings-'))
  const settingsPath = join(agentDir, 'settings.json')
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR
  const previousOffline = process.env.PI_OFFLINE
  process.env.PI_CODING_AGENT_DIR = agentDir
  process.env.PI_OFFLINE = '1'

  try {
    await writeFile(
      settingsPath,
      JSON.stringify({
        customGlobalKey: { keep: true },
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
    const saved = JSON.parse(await readFile(settingsPath, 'utf8')) as {
      customGlobalKey: { keep: boolean }
      agents: Record<string, Record<string, unknown>>
    }
    assert.deepEqual(saved.customGlobalKey, { keep: true })
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
