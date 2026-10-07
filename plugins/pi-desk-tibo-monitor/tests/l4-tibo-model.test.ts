import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

const testRoot = join(process.cwd(), 'temp/pi/tibo-monitor-test')
await mkdir(testRoot, { recursive: true })
const root = await mkdtemp(join(testRoot, 'run-'))
const agentDir = join(root, 'agent')
await mkdir(agentDir, { recursive: true })
process.env.PI_CODING_AGENT_DIR = agentDir
process.env.PI_CODING_AGENT_SESSION_DIR = join(agentDir, 'sessions')
const { parseAnalysis } = await import('../src/l4-tibo-model.js')
await rm(root, { recursive: true, force: true })

const ANALYSIS = {
  translation: '中文翻译',
  reset: { level: 'none' as const, reason: '没有重置信号' },
  times: []
}

test('模型分析解析接受JSON代码围栏并拒绝非法结构', () => {
  assert.deepEqual(parseAnalysis(`\n\`\`\`json\n${JSON.stringify(ANALYSIS)}\n\`\`\`\n`), ANALYSIS)
  assert.throws(() => parseAnalysis('{"translation":"缺字段"}'), /结构无效/)
  assert.throws(() => parseAnalysis('not-json'), /有效分析 JSON/)
})
