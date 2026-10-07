import assert from 'node:assert/strict'
import test from 'node:test'
import {
  addDays,
  dateKeyAt,
  dateStart,
  monthRange,
  zonedHourStart,
  buildUsageCalendarRange
} from '../src/l4-usage-calendar.js'

const HOUR = 60 * 60 * 1000

test('自然日边界遵循设置时区并支持夏令时的23和25小时日', () => {
  const zone = 'America/New_York'
  assert.equal(dateStart('2024-03-10', zone), Date.parse('2024-03-10T05:00:00Z'))
  assert.equal(dateStart('2024-03-11', zone) - dateStart('2024-03-10', zone), 23 * HOUR)
  assert.equal(dateStart('2024-11-04', zone) - dateStart('2024-11-03', zone), 25 * HOUR)
  assert.deepEqual(monthRange('2024-03', zone), {
    startAt: Date.parse('2024-03-01T05:00:00Z'),
    endAt: Date.parse('2024-04-01T04:00:00Z')
  })
  assert.equal(addDays('2024-11-03', 1), '2024-11-04')
  assert.equal(dateKeyAt(Date.parse('2024-03-10T04:59:59Z'), zone), '2024-03-09')
})

test('半小时夏令时与45分钟时区不退化为固定UTC偏移', () => {
  assert.equal(
    dateStart('2024-10-07', 'Australia/Lord_Howe') - dateStart('2024-10-06', 'Australia/Lord_Howe'),
    23.5 * HOUR
  )
  assert.equal(dateStart('2024-01-01', 'Asia/Kathmandu'), Date.parse('2023-12-31T18:15:00Z'))
  assert.equal(
    zonedHourStart(Date.parse('2024-01-01T00:35:00Z'), 'Asia/Kathmandu'),
    Date.parse('2024-01-01T00:15:00Z')
  )
})

test('月历返回真实自然日范围而不是连续24小时窗口', () => {
  const zone = 'America/New_York'
  const startAt = Date.parse('2024-11-02T04:00:00Z')
  const endAt = Date.parse('2024-11-05T05:00:00Z')
  const days = buildUsageCalendarRange(startAt, endAt, [], null, zone)
  assert.deepEqual(
    days.map((day) => day.date),
    ['2024-11-02', '2024-11-03', '2024-11-04']
  )
  assert.deepEqual(
    days.map((day) => (day.endAt - day.startAt) / HOUR),
    [24, 25, 24]
  )
})
