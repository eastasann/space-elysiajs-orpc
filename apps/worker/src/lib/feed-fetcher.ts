/**
 * Fetches one feed document, politely and defensively.
 *
 * A feed url is entered freely by an operator, so this treats it as hostile:
 * only `http`/`https` is followed, redirects are bounded, the response is
 * capped, and every network-facing call goes through an injectable `fetch` so
 * tests never touch the real network.
 */

const DEFAULT_TIMEOUT_MS = 10_000
const DEFAULT_MAX_BYTES = 5_000_000
const DEFAULT_MAX_REDIRECTS = 5
const DEFAULT_USER_AGENT =
  'Newsdeck-Collector/1.0 (+https://github.com/eastasann/space-elysiajs-orpc)'

export type FeedFetchErrorReason =
  | 'invalid-scheme'
  | 'timeout'
  | 'network'
  | 'too-many-redirects'
  | 'oversized'
  | 'http-error'

/**
 * Raised for every failure mode `fetchFeed` can produce.
 *
 * `retryable` is the one thing a caller needs to decide whether to let BullMQ
 * retry the job or raise `UnrecoverableError` instead — see
 * `../handlers/sources-fetch.ts`.
 */
export class FeedFetchError extends Error {
  readonly reason: FeedFetchErrorReason
  readonly retryable: boolean
  readonly status?: number

  constructor(reason: FeedFetchErrorReason, retryable: boolean, message: string, status?: number) {
    super(message)
    this.name = 'FeedFetchError'
    this.reason = reason
    this.retryable = retryable
    this.status = status
  }
}

export interface FetchFeedOptions {
  url: string
  /** Sent as `If-None-Match` when present. */
  etag?: string | null
  /** Sent as `If-Modified-Since` when present. */
  lastModified?: string | null
  timeoutMs?: number
  maxBytes?: number
  maxRedirects?: number
  userAgent?: string
  /** Injection point for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch
}

export type FetchFeedResult =
  | { status: 'not-modified' }
  | {
      status: 'fetched'
      body: string
      contentType: string | null
      etag: string | null
      lastModified: string | null
    }

function assertHttpUrl(raw: string): string {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new FeedFetchError('invalid-scheme', false, `"${raw}" is not a valid URL`)
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new FeedFetchError(
      'invalid-scheme',
      false,
      `refusing non-http(s) scheme "${parsed.protocol}" for "${raw}"`,
    )
  }

  return parsed.toString()
}

/** Reads the body up to `maxBytes`, aborting the stream rather than buffering past it. */
async function readBoundedBody(response: Response, maxBytes: number): Promise<string> {
  const declaredLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new FeedFetchError(
      'oversized',
      false,
      `declared content-length ${declaredLength} exceeds the ${maxBytes} byte limit`,
    )
  }

  const reader = response.body?.getReader()
  if (!reader) return response.text()

  const chunks: Uint8Array[] = []
  let total = 0

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel()
      throw new FeedFetchError('oversized', false, `response exceeded the ${maxBytes} byte limit`)
    }
    chunks.push(value)
  }

  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }

  return new TextDecoder().decode(merged)
}

export async function fetchFeed(options: FetchFeedOptions): Promise<FetchFeedResult> {
  const {
    etag,
    lastModified,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxBytes = DEFAULT_MAX_BYTES,
    maxRedirects = DEFAULT_MAX_REDIRECTS,
    userAgent = DEFAULT_USER_AGENT,
    fetchImpl = fetch,
  } = options

  let currentUrl = assertHttpUrl(options.url)

  for (let redirectCount = 0; ; redirectCount++) {
    const headers: Record<string, string> = {
      'User-Agent': userAgent,
      Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
    }
    if (etag) headers['If-None-Match'] = etag
    if (lastModified) headers['If-Modified-Since'] = lastModified

    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, timeoutMs)

    let response: Response
    try {
      response = await fetchImpl(currentUrl, {
        signal: controller.signal,
        redirect: 'manual',
        headers,
      })
    } catch (error) {
      if (timedOut) {
        throw new FeedFetchError(
          'timeout',
          true,
          `request to "${currentUrl}" timed out after ${timeoutMs}ms`,
        )
      }
      const message = error instanceof Error ? error.message : String(error)
      throw new FeedFetchError('network', true, `request to "${currentUrl}" failed: ${message}`)
    } finally {
      clearTimeout(timer)
    }

    if (response.status === 304) return { status: 'not-modified' }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location')
      if (!location) {
        throw new FeedFetchError(
          'http-error',
          false,
          `redirect from "${currentUrl}" carried no Location header (status ${response.status})`,
          response.status,
        )
      }
      if (redirectCount >= maxRedirects) {
        throw new FeedFetchError(
          'too-many-redirects',
          false,
          `"${options.url}" exceeded ${maxRedirects} redirects`,
          response.status,
        )
      }
      currentUrl = assertHttpUrl(new URL(location, currentUrl).toString())
      continue
    }

    if (response.status === 404 || response.status === 410) {
      throw new FeedFetchError(
        'http-error',
        false,
        `feed responded ${response.status} for "${currentUrl}"`,
        response.status,
      )
    }

    if (response.status >= 500) {
      throw new FeedFetchError(
        'http-error',
        true,
        `feed responded ${response.status} for "${currentUrl}"`,
        response.status,
      )
    }

    if (!response.ok) {
      throw new FeedFetchError(
        'http-error',
        false,
        `feed responded ${response.status} for "${currentUrl}"`,
        response.status,
      )
    }

    const body = await readBoundedBody(response, maxBytes)
    return {
      status: 'fetched',
      body,
      contentType: response.headers.get('content-type'),
      etag: response.headers.get('etag'),
      lastModified: response.headers.get('last-modified'),
    }
  }
}
