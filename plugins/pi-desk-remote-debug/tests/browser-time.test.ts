import assert from 'node:assert/strict'
import test from 'node:test'
import { formatRemoteDebugTime, resolveRemoteDebugTimeZone } from '../src/browser-time.js'

const TIME = Date.UTC(2024, 0, 1, 12)
const OPTIONS: Intl.DateTimeFormatOptions = {
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false
}

test('Remote Debug使用非上海IANA时区和当前语言展示运行时间', () => {
  const timeZone = resolveRemoteDebugTimeZone(() => 'America/Los_Angeles')
  assert.equal(timeZone, 'America/Los_Angeles')
  assert.equal(
    formatRemoteDebugTime(TIME, 'en-US', timeZone),
    new Intl.DateTimeFormat('en-US', { ...OPTIONS, timeZone }).format(TIME)
  )
  assert.notEqual(
    formatRemoteDebugTime(TIME, 'en-US', timeZone),
    new Intl.DateTimeFormat('en-US', { ...OPTIONS, timeZone: 'Asia/Shanghai' }).format(TIME)
  )
})

test('Remote Debug无法检测浏览器时区时回退UTC', () => {
  const timeZone = resolveRemoteDebugTimeZone(() => {
    throw new Error('timezone unavailable')
  })
  assert.equal(timeZone, 'UTC')
  assert.equal(
    formatRemoteDebugTime(TIME, 'en-US', timeZone),
    new Intl.DateTimeFormat('en-US', { ...OPTIONS, timeZone: 'UTC' }).format(TIME)
  )
  assert.equal(formatRemoteDebugTime(null, 'en-US', timeZone), '—')
})
