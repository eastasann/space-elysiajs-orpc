import dns from 'node:dns'
import net from 'node:net'

/**
 * Fetches one feed document, politely and defensively.
 *
 * A feed url is entered freely by an operator, so this treats it as hostile:
 * only `http`/`https` is followed, the resolved address is checked against
 * loopback/link-local/private ranges on every hop, redirects are bounded, the
 * response is capped, and every network-facing call goes through an
 * injectable `fetch` so tests never touch the real network.
 */

const DEFAULT_TIMEOUT_MS = 10_000
const DEFAULT_MAX_BYTES = 5_000_000
const DEFAULT_MAX_REDIRECTS = 5
const DEFAULT_USER_AGENT =
  'Newsdeck-Collector/1.0 (+https://github.com/eastasann/space-elysiajs-orpc)'

export type FeedFetchErrorReason =
  | 'invalid-scheme'
  | 'private-address'
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
  /** Resolves a hostname to the addresses it would connect to; defaults to a real DNS lookup. Injection point for tests. */
  resolveHostname?: (hostname: string) => Promise<string[]>
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

/** Real DNS lookup used outside of tests; resolves both A and AAAA records. */
async function lookupHostnameAddresses(hostname: string): Promise<string[]> {
  const records = await dns.promises.lookup(hostname, { all: true })
  return records.map((record) => record.address)
}

function isPrivateIPv4(address: string): boolean {
  const octets = address.split('.').map(Number)
  if (
    octets.length !== 4 ||
    octets.some((octet) => Number.isNaN(octet) || octet < 0 || octet > 255)
  ) {
    return false
  }
  const [a, b] = octets as [number, number, number, number]
  if (a === 0) return true // "this network" / unspecified
  if (a === 127) return true // loopback
  if (a === 10) return true // private
  if (a === 169 && b === 254) return true // link-local, incl. cloud metadata (169.254.169.254)
  if (a === 172 && b >= 16 && b <= 31) return true // private
  if (a === 192 && b === 168) return true // private
  return false
}

/** Covers the address forms a resolver or a `new URL(...)` can hand back: plain IPv4, IPv4-mapped IPv6, and IPv6 loopback/link-local/unique-local. */
function isPrivateIPv6(address: string): boolean {
  const normalized = address.toLowerCase()
  if (normalized === '::1' || normalized === '::') return true

  const mappedV4 = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
  if (mappedV4) return isPrivateIPv4(mappedV4[1] as string)

  const mappedHex = normalized.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
  if (mappedHex) {
    const hi = Number.parseInt(mappedHex[1] as string, 16)
    const lo = Number.parseInt(mappedHex[2] as string, 16)
    return isPrivateIPv4(`${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`)
  }

  if (/^fe[89ab][0-9a-f]:/.test(normalized)) return true // link-local, fe80::/10
  if (/^f[cd][0-9a-f]{2}:/.test(normalized)) return true // unique local, fc00::/7
  return false
}

function isPrivateAddress(address: string): boolean {
  const family = net.isIP(address)
  if (family === 4) return isPrivateIPv4(address)
  if (family === 6) return isPrivateIPv6(address)
  return false
}

/** Races `resolveHostname` against `signal`, so a slow or hanging DNS server cannot outlast the request's own deadline. */
function resolveWithDeadline(
  resolveHostname: (hostname: string) => Promise<string[]>,
  hostname: string,
  signal: AbortSignal,
): Promise<string[]> {
  if (signal.aborted) return Promise.reject(new DOMException('aborted', 'AbortError'))
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new DOMException('aborted', 'AbortError'))
    signal.addEventListener('abort', onAbort, { once: true })
    resolveHostname(hostname)
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', onAbort))
  })
}

/**
 * A url that has passed `assertSafeUrl`: `logicalUrl` is what redirects are
 * resolved against and what appears in error messages; `connectUrl` is what
 * `fetchImpl` is actually called with.
 *
 * For a non-IP hostname these differ: `connectUrl` has the hostname replaced
 * by the address that was just resolved and checked, so `fetchImpl` connects
 * to the address this function validated instead of re-resolving the
 * hostname itself — a second lookup could answer differently from the first
 * (DNS rebinding) in the gap between the check and the connection it guards.
 * `hostHeader` and `tlsServerName` carry the original hostname through so the
 * request is still addressed, and its certificate verified, by name.
 */
interface SafeUrl {
  logicalUrl: string
  connectUrl: string
  hostHeader: string
  tlsServerName: string | undefined
}

/**
 * Parses and validates a feed url: rejects non-`http(s)` schemes, then
 * resolves the hostname and rejects any address that is loopback,
 * link-local or private. Checking the hostname string is not enough — a
 * public name can resolve to a private address, and the resolved address is
 * what the request will actually reach.
 */
async function assertSafeUrl(
  raw: string,
  resolveHostname: (hostname: string) => Promise<string[]>,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<SafeUrl> {
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

  const hostname = parsed.hostname.replace(/^\[|\]$/g, '')
  const isLiteralIp = net.isIP(hostname) !== 0

  let addresses: string[]
  if (isLiteralIp) {
    addresses = [hostname]
  } else {
    try {
      addresses = await resolveWithDeadline(resolveHostname, hostname, signal)
    } catch (error) {
      if (signal.aborted) {
        throw new FeedFetchError(
          'timeout',
          true,
          `resolving "${hostname}" timed out after ${timeoutMs}ms`,
        )
      }
      const message = error instanceof Error ? error.message : String(error)
      throw new FeedFetchError('network', true, `could not resolve "${hostname}": ${message}`)
    }
  }

  if (addresses.length === 0) {
    throw new FeedFetchError('network', true, `"${hostname}" did not resolve to any address`)
  }

  const privateAddress = addresses.find(isPrivateAddress)
  if (privateAddress !== undefined) {
    throw new FeedFetchError(
      'private-address',
      false,
      `refusing to fetch "${raw}": "${hostname}" resolves to private address "${privateAddress}"`,
    )
  }

  const logicalUrl = parsed.toString()
  if (isLiteralIp) {
    return { logicalUrl, connectUrl: logicalUrl, hostHeader: parsed.host, tlsServerName: undefined }
  }

  const pinnedAddress = addresses[0] as string
  const connect = new URL(logicalUrl)
  connect.hostname = net.isIP(pinnedAddress) === 6 ? `[${pinnedAddress}]` : pinnedAddress
  return {
    logicalUrl,
    connectUrl: connect.toString(),
    hostHeader: parsed.host,
    tlsServerName: parsed.protocol === 'https:' ? hostname : undefined,
  }
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
    resolveHostname = lookupHostnameAddresses,
  } = options

  // One controller for the whole call, including every redirect hop, so the
  // deadline is a budget for the request as a whole rather than being reset
  // on each hop.
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)

  try {
    let current = await assertSafeUrl(options.url, resolveHostname, controller.signal, timeoutMs)

    for (let redirectCount = 0; ; redirectCount++) {
      const headers: Record<string, string> = {
        'User-Agent': userAgent,
        Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
        Host: current.hostHeader,
      }
      if (etag) headers['If-None-Match'] = etag
      if (lastModified) headers['If-Modified-Since'] = lastModified

      let response: Response
      try {
        response = await fetchImpl(current.connectUrl, {
          signal: controller.signal,
          redirect: 'manual',
          headers,
          ...(current.tlsServerName ? { tls: { serverName: current.tlsServerName } } : {}),
        })
      } catch (error) {
        if (timedOut) {
          throw new FeedFetchError(
            'timeout',
            true,
            `request to "${current.logicalUrl}" timed out after ${timeoutMs}ms`,
          )
        }
        const message = error instanceof Error ? error.message : String(error)
        throw new FeedFetchError(
          'network',
          true,
          `request to "${current.logicalUrl}" failed: ${message}`,
        )
      }

      if (response.status === 304) return { status: 'not-modified' }

      if (response.status >= 300 && response.status < 400) {
        // The redirect target replaces this response; drop its body instead
        // of holding the connection open until the next hop settles.
        await response.body?.cancel()

        const location = response.headers.get('location')
        if (!location) {
          throw new FeedFetchError(
            'http-error',
            false,
            `redirect from "${current.logicalUrl}" carried no Location header (status ${response.status})`,
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
        current = await assertSafeUrl(
          new URL(location, current.logicalUrl).toString(),
          resolveHostname,
          controller.signal,
          timeoutMs,
        )
        continue
      }

      if (response.status === 404 || response.status === 410) {
        throw new FeedFetchError(
          'http-error',
          false,
          `feed responded ${response.status} for "${current.logicalUrl}"`,
          response.status,
        )
      }

      if (response.status >= 500) {
        throw new FeedFetchError(
          'http-error',
          true,
          `feed responded ${response.status} for "${current.logicalUrl}"`,
          response.status,
        )
      }

      if (!response.ok) {
        throw new FeedFetchError(
          'http-error',
          false,
          `feed responded ${response.status} for "${current.logicalUrl}"`,
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
  } finally {
    clearTimeout(timer)
  }
}
