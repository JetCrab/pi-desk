import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildUsageCalendar as calendar,
  buildUsageCalendarRange as calendarRange,
  dateKeyAt as zonedDateKey,
  dateStart as zonedDateStart,
  monthWeekdayOffset,
  zonedHourStart
} from '../src/l4-usage-calendar.js'
import { formatTokens } from '../src/l4-usage-format.js'
import type { UsageSeriesPoint, UsageTotals } from '../src/protocol.js'

const ZONE = 'Asia/Shanghai'
const dateStart = (date: string): number => zonedDateStart(date, ZONE)
const dateKeyAt = (value: number): string => zonedDateKey(value, ZONE)
const buildUsageCalendar = (
  month: string,
  points: UsageSeriesPoint[],
  model: string | null,
  endAt?: number
): ReturnType<typeof calendar> => calendar(month, points, model, endAt, ZONE)
const buildUsageCalendarRange = (
  startAt: number,
  endAt: number,
  points: UsageSeriesPoint[],
  model: string | null
): ReturnType<typeof calendarRange> => calendarRange(startAt, endAt, points, model, ZONE)

const EMPTY_TOTALS: UsageTotals = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cost: 0
}

function totals(values: Partial<UsageTotals>): UsageTotals {
  return { ...EMPTY_TOTALS, ...values }
}

function point(
  startAt: number,
  endAt: number,
  value: UsageTotals,
  modelValue?: UsageTotals
): UsageSeriesPoint {
  return {
    startAt,
    endAt,
    totals: value,
    models:
      modelValue === undefined
        ? []
        : [
            {
              key: 'model-a',
              provider: 'test',
              model: 'model-a',
              label: 'Model A',
              calls: 1,
              totals: modelValue
            }
          ]
  }
}

test('Token 在亿级切换为中文单位', () => {
  assert.equal(formatTokens(999), '999')
  assert.equal(formatTokens(1_000), '1.0K')
  assert.equal(formatTokens(1_000_000), '1.00M')
  assert.equal(formatTokens(99_999_999), '100.0M')
  assert.equal(formatTokens(100_000_000), '1亿')
  assert.equal(formatTokens(123_456_789), '1.23亿')
  assert.equal(formatTokens(1_000_000_000), '10亿')
})

test('月历按上海自然日合并多个时间桶', () => {
  const firstDay = dateStart('2026-08-01')
  const days = buildUsageCalendar(
    '2026-08',
    [
      point(
        firstDay,
        firstDay + 6 * 60 * 60 * 1000,
        totals({ input: 10, cacheRead: 20, output: 2, cost: 0.1 }),
        totals({ input: 3, cacheRead: 4, output: 1, cost: 0.02 })
      ),
      point(
        firstDay + 6 * 60 * 60 * 1000,
        firstDay + 12 * 60 * 60 * 1000,
        totals({ input: 30, cacheRead: 40, output: 5, cost: 0.3 }),
        totals({ input: 7, cacheRead: 8, output: 2, cost: 0.04 })
      ),
      point(
        dateStart('2026-08-02'),
        dateStart('2026-08-03'),
        totals({ input: 50, cacheRead: 60, output: 8, cost: 0.5 }),
        totals({ input: 11, cacheRead: 12, output: 3, cost: 0.06 })
      )
    ],
    null
  )

  assert.equal(days.length, 31)
  assert.deepEqual(days[0]?.totals, totals({ input: 40, cacheRead: 60, output: 7, cost: 0.4 }))
  assert.deepEqual(days[1]?.totals, totals({ input: 50, cacheRead: 60, output: 8, cost: 0.5 }))
  assert.deepEqual(days[2]?.totals, EMPTY_TOTALS)
  assert.equal(days[0]?.startAt, firstDay)
  assert.equal(days[0]?.endAt, dateStart('2026-08-02'))
})

test('月历模型筛选只累计对应模型', () => {
  const firstDay = dateStart('2026-08-01')
  const days = buildUsageCalendar(
    '2026-08',
    [
      point(
        firstDay,
        firstDay + 60 * 60 * 1000,
        totals({ input: 10, cacheRead: 20 }),
        totals({ input: 3, cacheRead: 4 })
      )
    ],
    'model-a'
  )

  assert.deepEqual(days[0]?.totals, totals({ input: 3, cacheRead: 4 }))
})

test('范围日历按自然日生成并截断当前日结束时间', () => {
  const startAt = dateStart('2026-08-22')
  const endAt = dateStart('2026-08-28') + 13 * 60 * 60 * 1000
  const days = buildUsageCalendarRange(startAt, endAt, [], null)

  assert.equal(days.length, 7)
  assert.equal(days[0]?.date, '2026-08-22')
  assert.equal(days[6]?.date, '2026-08-28')
  assert.equal(days[0]?.startAt, startAt)
  assert.equal(days[6]?.endAt, endAt)
})

test('完整月历保留未来日期并截断当前日结束时间', () => {
  const dataEndAt = dateStart('2026-08-03') + 13 * 60 * 60 * 1000
  const days = buildUsageCalendar('2026-08', [], null, dataEndAt)

  assert.equal(days.length, 31)
  assert.equal(days[2]?.endAt, dataEndAt)
  assert.equal(days[3]?.startAt, dateStart('2026-08-04'))
  assert.equal(days[3]?.endAt, dateStart('2026-08-05'))
})

test('月历使用周一作为一周起点并保持上海日期边界', () => {
  assert.equal(monthWeekdayOffset('2026-08'), 5)
  assert.equal(dateKeyAt(dateStart('2026-08-01') - 1), '2026-07-31')
  assert.equal(dateKeyAt(dateStart('2026-08-01')), '2026-08-01')
})

test('24 小时范围向下对齐到上海整点', () => {
  const value = Date.UTC(2026, 7, 28, 0, 37) - 8 * 60 * 60 * 1000
  assert.equal(zonedHourStart(value, ZONE), Date.UTC(2026, 7, 28, 0) - 8 * 60 * 60 * 1000)
})
