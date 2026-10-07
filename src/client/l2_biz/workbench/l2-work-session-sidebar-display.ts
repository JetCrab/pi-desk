const ONE_DAY_MS = 24 * 60 * 60 * 1_000

type WorkSessionUpdatedAtTone = 'fresh' | 'recent' | 'old'

function elapsedMinutes(timestamp: number, now: number): number {
  return Math.max(0, Math.floor((now - timestamp) / 60_000))
}

function updatedAtTone(timestamp: number | null, now: number | null): WorkSessionUpdatedAtTone {
  if (timestamp === null || now === null) return 'old'

  const minutes = elapsedMinutes(timestamp, now)
  if (minutes < 5) return 'fresh'
  if (minutes < 60) return 'recent'
  return 'old'
}

let cachedFormatters: {
  locale: string
  timeZone: string
  title: Intl.DateTimeFormat
  dateKey: Intl.DateTimeFormat
  compact: Intl.DateTimeFormat
} | null = null

function formatters(locale: string, timeZone: string): NonNullable<typeof cachedFormatters> {
  if (cachedFormatters?.locale === locale && cachedFormatters.timeZone === timeZone)
    return cachedFormatters
  const displayLocale = locale === 'en' ? 'en-US' : 'zh-CN'
  cachedFormatters = {
    locale,
    timeZone,
    title: new Intl.DateTimeFormat(displayLocale, {
      timeZone,
      timeZoneName: 'shortOffset',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23'
    }),
    dateKey: new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric'
    }),
    compact: new Intl.DateTimeFormat(displayLocale, { timeZone, month: 'short', day: 'numeric' })
  }
  return cachedFormatters
}

function calendarDay(timestamp: number, formatter: Intl.DateTimeFormat): number {
  const parts = formatter.formatToParts(timestamp)
  const number = (part: string): number => Number(parts.find((item) => item.type === part)?.value)
  return Date.UTC(number('year'), number('month') - 1, number('day'))
}

export function formatL2WorkSessionUpdatedAt(
  timestamp: number | null,
  now: number | null,
  locale = 'en',
  timeZone = 'UTC'
): { compact: string; title: string; tone: WorkSessionUpdatedAtTone } {
  const tone = updatedAtTone(timestamp, now)
  if (timestamp === null)
    return { compact: '--', title: locale === 'en' ? 'No messages yet' : '暂无消息时间', tone }

  const current = formatters(locale, timeZone)
  const title = current.title.format(timestamp)
  if (now === null) return { compact: title, title, tone }

  const minutes = elapsedMinutes(timestamp, now)
  if (minutes < 1) return { compact: locale === 'en' ? 'Just now' : '刚刚', title, tone }
  if (minutes < 60)
    return { compact: locale === 'en' ? `${minutes} min ago` : `${minutes} 分钟前`, title, tone }

  const hours = Math.floor(minutes / 60)
  if (hours < 24)
    return { compact: locale === 'en' ? `${hours} hr ago` : `${hours} 小时前`, title, tone }

  const dayDifference =
    (calendarDay(now, current.dateKey) - calendarDay(timestamp, current.dateKey)) / ONE_DAY_MS
  if (dayDifference === 1) return { compact: locale === 'en' ? 'Yesterday' : '昨天', title, tone }
  if (dayDifference === 2) return { compact: locale === 'en' ? '2 days ago' : '前天', title, tone }

  const date = current.compact.format(timestamp)
  return { compact: date, title, tone }
}
