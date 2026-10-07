import type { UsageSeriesPoint, UsageTotals } from './protocol.js'

export const HOUR_MS = 60 * 60 * 1000
export const DAY_MS = 24 * HOUR_MS

const EMPTY_TOTALS: UsageTotals = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cost: 0
}

export type CalendarMetric = 'prompt' | 'output' | 'cacheRead' | 'cost'

export interface UsageCalendarDay {
  date: string
  startAt: number
  endAt: number
  totals: UsageTotals
}

const formatters = new Map<string, Intl.DateTimeFormat>()

function zonedParts(value: number, timeZone: string): Record<string, number> {
  let formatter = formatters.get(timeZone)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23'
    })
    if (formatters.size >= 8) formatters.delete(formatters.keys().next().value!)
    formatters.set(timeZone, formatter)
  }
  return Object.fromEntries(
    formatter
      .formatToParts(value)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, Number(part.value)])
  )
}

function dateKeyFromParts(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

export function dateKeyAt(value: number, timeZone = 'UTC'): string {
  const parts = zonedParts(value, timeZone)
  return dateKeyFromParts(parts.year!, parts.month!, parts.day!)
}

export function dateStart(date: string, timeZone = 'UTC'): number {
  const [year, month, day] = date.split('-').map(Number)
  const utc = Date.UTC(year!, month! - 1, day!)
  let low = utc - 2 * DAY_MS
  let high = utc + 2 * DAY_MS
  // 查找该日期的第一个真实时刻，午夜被夏令时跳过时也不假定固定偏移。
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2)
    if (dateKeyAt(middle, timeZone) < date) low = middle
    else high = middle
  }
  return high
}

function offsetAt(value: number, timeZone: string): number {
  const parts = zonedParts(value, timeZone)
  return (
    Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour!, parts.minute!, parts.second!) -
    Math.floor(value / 1000) * 1000
  )
}

export function zonedHourStart(value: number, timeZone = 'UTC'): number {
  const parts = zonedParts(value, timeZone)
  let low = value - parts.minute! * 60_000 - parts.second! * 1000 - (value % 1000)
  const offset = offsetAt(value, timeZone)
  if (offsetAt(low, timeZone) === offset) return low
  // 半小时切换可能使本次小时从 :30 开始；保留当前重复小时的实际边界。
  let high = value
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2)
    if (offsetAt(middle, timeZone) === offset) high = middle
    else low = middle
  }
  return high
}

export function addDays(date: string, amount: number): string {
  const [year, month, day] = date.split('-').map(Number)
  const value = new Date(Date.UTC(year!, month! - 1, day! + amount))
  return dateKeyFromParts(value.getUTCFullYear(), value.getUTCMonth() + 1, value.getUTCDate())
}

export function monthKeyAt(value: number, timeZone = 'UTC'): string {
  return dateKeyAt(value, timeZone).slice(0, 7)
}

export function addMonths(monthKey: string, amount: number): string {
  const [year, month] = monthKey.split('-').map(Number)
  const value = new Date(Date.UTC(year!, month! - 1 + amount, 1))
  return `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, '0')}`
}

export function monthRange(monthKey: string, timeZone = 'UTC'): { startAt: number; endAt: number } {
  return {
    startAt: dateStart(`${monthKey}-01`, timeZone),
    endAt: dateStart(`${addMonths(monthKey, 1)}-01`, timeZone)
  }
}

export function monthWeekdayOffset(monthKey: string): number {
  const weekday = new Date(`${monthKey}-01T00:00:00Z`).getUTCDay()
  return weekday === 0 ? 6 : weekday - 1
}

export function formatMonth(monthKey: string, timeZone = 'UTC'): string {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone,
    year: 'numeric',
    month: 'long'
  }).format(monthRange(monthKey, timeZone).startAt)
}

export function usageBucketRanges(
  startAt: number,
  endAt: number,
  bucketMs: number,
  timeZone = 'UTC'
): { startAt: number; endAt: number }[] {
  const buckets: { startAt: number; endAt: number }[] = []
  let cursor = startAt
  while (cursor < endAt) {
    const nextDay = dateStart(addDays(dateKeyAt(cursor, timeZone), 1), timeZone)
    const dayEnd = Math.min(endAt, nextDay)
    while (cursor < dayEnd) {
      // 日粒度使用完整自然日；更细粒度在午夜截断，次日重新开始。
      const bucketEnd = bucketMs === DAY_MS ? dayEnd : Math.min(dayEnd, cursor + bucketMs)
      buckets.push({ startAt: cursor, endAt: bucketEnd })
      cursor = bucketEnd
    }
  }
  return buckets
}

export function usageBucketIndex(buckets: readonly { endAt: number }[], timestamp: number): number {
  let low = 0
  let high = buckets.length
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if (buckets[middle]!.endAt <= timestamp) low = middle + 1
    else high = middle
  }
  return low
}

function pointTotals(point: UsageSeriesPoint, modelKey: string | null): UsageTotals {
  if (!modelKey) return point.totals
  return point.models.find((model) => model.key === modelKey)?.totals ?? EMPTY_TOTALS
}

function addTotals(target: UsageTotals, value: UsageTotals): void {
  target.input += value.input
  target.output += value.output
  target.cacheRead += value.cacheRead
  target.cacheWrite += value.cacheWrite
  target.cost += value.cost
}

function aggregateTotalsByDate(
  points: readonly UsageSeriesPoint[],
  modelKey: string | null,
  timeZone: string
): Map<string, UsageTotals> {
  const totalsByDate = new Map<string, UsageTotals>()
  for (const point of points) {
    const date = dateKeyAt(point.startAt, timeZone)
    const totals = totalsByDate.get(date) ?? { ...EMPTY_TOTALS }
    addTotals(totals, pointTotals(point, modelKey))
    totalsByDate.set(date, totals)
  }
  return totalsByDate
}

export function buildUsageCalendarRange(
  startAt: number,
  endAt: number,
  points: readonly UsageSeriesPoint[],
  modelKey: string | null,
  timeZone = 'UTC'
): UsageCalendarDay[] {
  if (endAt <= startAt) return []
  const totalsByDate = aggregateTotalsByDate(points, modelKey, timeZone)
  const firstDate = dateKeyAt(startAt, timeZone)
  const lastDate = dateKeyAt(endAt - 1, timeZone)
  const days: UsageCalendarDay[] = []
  let date = firstDate
  let dayStart = dateStart(date, timeZone)
  while (true) {
    const dayEnd = dateStart(addDays(date, 1), timeZone)
    days.push({
      date,
      startAt: Math.max(startAt, dayStart),
      endAt: Math.min(endAt, dayEnd),
      totals: totalsByDate.get(date) ?? { ...EMPTY_TOTALS }
    })
    if (date === lastDate) break
    date = addDays(date, 1)
    dayStart = dayEnd
  }
  return days
}

export function buildUsageCalendar(
  monthKey: string,
  points: readonly UsageSeriesPoint[],
  modelKey: string | null,
  dataEndAt?: number,
  timeZone = 'UTC'
): UsageCalendarDay[] {
  const range = monthRange(monthKey, timeZone)
  const days = buildUsageCalendarRange(range.startAt, range.endAt, points, modelKey, timeZone)
  if (dataEndAt === undefined || dataEndAt >= range.endAt) return days
  return days.map((day) =>
    day.startAt < dataEndAt ? { ...day, endAt: Math.min(day.endAt, dataEndAt) } : day
  )
}
