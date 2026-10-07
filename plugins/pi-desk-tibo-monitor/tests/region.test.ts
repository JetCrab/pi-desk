import assert from 'node:assert/strict'
import test from 'node:test'
import { tiboAnalysisPrompt } from '../src/l4-tibo-prompt.js'
import { analysisSchema } from '../src/l4-tibo-protocol.js'

test('分析模板只使用宿主指定的语言和IANA时区', () => {
  const english = tiboAnalysisPrompt({ locale: 'en', timeZone: 'America/New_York' })
  assert.match(english, /英文/)
  assert.match(english, /America\/New_York/)
  assert.match(english, /localTime/)
  assert.doesNotMatch(english, /北京时间|Asia\/Shanghai|"beijing"/)
  const chinese = tiboAnalysisPrompt({ locale: 'zh-CN', timeZone: 'Asia/Kathmandu' })
  assert.match(chinese, /简体中文/)
  assert.match(chinese, /Asia\/Kathmandu/)
})

test('旧beijing分析可读取为通用时间字段，新分析不携带旧字段', () => {
  const parsed = analysisSchema.parse({
    translation: '旧译文',
    reset: { level: 'none', reason: '无' },
    times: [{ source: 'tomorrow', beijing: '2024-01-01 08:00', assumption: '' }]
  })
  assert.deepEqual(parsed.times, [
    { source: 'tomorrow', localTime: '2024-01-01 08:00', assumption: '' }
  ])
  assert.deepEqual(analysisSchema.parse(parsed), parsed)
})
