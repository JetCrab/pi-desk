export class QuotaHttpError extends Error {
  readonly status: number
  readonly retryAt: number | null

  constructor(message: string, status: number, retryAt: number | null) {
    super(message)
    this.name = 'QuotaHttpError'
    this.status = status
    this.retryAt = retryAt
  }
}

function parseRetryAt(value: string | null, now: number): number | null {
  if (!value) return null
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return now + seconds * 1000
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? timestamp : null
}

export async function requestJson(input: {
  fetch: typeof fetch
  url: string
  init?: RequestInit
  signal: AbortSignal
  label: string
  clock?: () => number
}): Promise<unknown> {
  const response = await input.fetch(input.url, {
    ...input.init,
    signal: input.signal
  })
  if (!response.ok) {
    throw new QuotaHttpError(
      `${input.label}失败（HTTP ${response.status}）`,
      response.status,
      response.status === 429
        ? parseRetryAt(response.headers.get('retry-after'), (input.clock ?? Date.now)())
        : null
    )
  }

  const text = await response.text()
  if (text.length > 1024 * 1024) throw new Error(`${input.label}返回内容超过 1MB`)
  try {
    return text ? JSON.parse(text) : {}
  } catch {
    throw new Error(`${input.label}返回了无效 JSON`)
  }
}
