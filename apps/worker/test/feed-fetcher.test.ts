import { describe, expect, it } from 'bun:test'
import http from 'node:http'
import type { FetchFeedOptions } from '../src/lib/feed-fetcher.ts'
import { FeedFetchError, fetchFeed as fetchFeedImpl } from '../src/lib/feed-fetcher.ts'

type FetchCall = { url: string; init: RequestInit | undefined }

function fakeFetch(impl: (url: string, init?: RequestInit) => Promise<Response> | Response) {
  const calls: FetchCall[] = []
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init })
    return impl(String(input), init)
  }) as typeof fetch
  return { fetchImpl, calls }
}

/** A public address `example.com` may resolve to, for tests that don't care about DNS. */
const PUBLIC_ADDRESS = '93.184.216.34'

/**
 * `fetchFeed` now connects to the resolved-and-checked address rather than
 * letting `fetchImpl` re-resolve the hostname (that second, independent
 * lookup is the DNS-rebinding gap it closes), so a fake `fetchImpl` sees
 * `https://93.184.216.34/...` rather than `https://example.com/...`. Tests
 * that need to key off the logical request match on `pathname` instead.
 */
function pathnameOf(url: string): string {
  return new URL(url).pathname
}

/** Wraps `fetchFeed` with a DNS resolver that returns a public address by default, so tests never touch real DNS. */
function fetchFeed(options: FetchFeedOptions) {
  return fetchFeedImpl({
    resolveHostname: () => Promise.resolve([PUBLIC_ADDRESS]),
    ...options,
  })
}

describe('fetchFeed', () => {
  it('fetches a feed and reports its body, content type and validators', async () => {
    const { fetchImpl, calls } = fakeFetch(
      () =>
        new Response('<rss></rss>', {
          status: 200,
          headers: {
            'content-type': 'application/rss+xml',
            etag: '"abc123"',
            'last-modified': 'Mon, 01 Jan 2024 00:00:00 GMT',
          },
        }),
    )

    const result = await fetchFeed({ url: 'https://example.com/feed.xml', fetchImpl })

    expect(result).toEqual({
      status: 'fetched',
      body: '<rss></rss>',
      contentType: 'application/rss+xml',
      etag: '"abc123"',
      lastModified: 'Mon, 01 Jan 2024 00:00:00 GMT',
    })
    expect(calls[0]?.init?.headers).toMatchObject({
      'User-Agent': expect.stringContaining('Newsdeck'),
    })
  })

  it('connects to the resolved address instead of the hostname, and carries the hostname through as Host and TLS servername', async () => {
    const { fetchImpl, calls } = fakeFetch(() => new Response('<rss></rss>', { status: 200 }))

    await fetchFeed({ url: 'https://example.com/feed.xml', fetchImpl })

    // The connection targets the address that assertSafeUrl already checked
    // rather than a hostname fetchImpl would resolve independently — that
    // second, independent resolution is the DNS-rebinding gap being closed.
    expect(calls[0]?.url).toBe(`https://${PUBLIC_ADDRESS}/feed.xml`)
    expect(calls[0]?.init?.headers).toMatchObject({ Host: 'example.com' })
    expect((calls[0]?.init as { tls?: { serverName?: string } } | undefined)?.tls).toEqual({
      serverName: 'example.com',
    })
  })

  it('does not pin or add a TLS servername when the url is already a literal address', async () => {
    const { fetchImpl, calls } = fakeFetch(() => new Response('<rss></rss>', { status: 200 }))

    await fetchFeedImpl({ url: 'http://93.184.216.34/feed.xml', fetchImpl })

    expect(calls[0]?.url).toBe('http://93.184.216.34/feed.xml')
    expect(calls[0]?.init?.headers).toMatchObject({ Host: '93.184.216.34' })
    expect((calls[0]?.init as { tls?: unknown } | undefined)?.tls).toBeUndefined()
  })

  it('sends stored validators as conditional request headers', async () => {
    const { fetchImpl, calls } = fakeFetch(() => new Response(null, { status: 304 }))

    const result = await fetchFeed({
      url: 'https://example.com/feed.xml',
      etag: '"abc123"',
      lastModified: 'Mon, 01 Jan 2024 00:00:00 GMT',
      fetchImpl,
    })

    expect(result).toEqual({ status: 'not-modified' })
    expect(calls[0]?.init?.headers).toMatchObject({
      'If-None-Match': '"abc123"',
      'If-Modified-Since': 'Mon, 01 Jan 2024 00:00:00 GMT',
    })
  })

  it('treats a timeout as retryable', async () => {
    const { fetchImpl } = fakeFetch(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
        }),
    )

    const error = await fetchFeed({
      url: 'https://example.com/feed.xml',
      timeoutMs: 20,
      fetchImpl,
    }).catch((caught) => caught)

    expect(error).toBeInstanceOf(FeedFetchError)
    expect((error as FeedFetchError).reason).toBe('timeout')
    expect((error as FeedFetchError).retryable).toBe(true)
  })

  it('treats a hanging DNS resolution as a timeout instead of waiting on it forever', async () => {
    const { fetchImpl, calls } = fakeFetch(() => new Response('<rss></rss>', { status: 200 }))

    const error = await fetchFeedImpl({
      url: 'https://example.com/feed.xml',
      timeoutMs: 20,
      fetchImpl,
      resolveHostname: () => new Promise(() => {}),
    }).catch((caught) => caught)

    expect(error).toBeInstanceOf(FeedFetchError)
    expect((error as FeedFetchError).reason).toBe('timeout')
    expect((error as FeedFetchError).retryable).toBe(true)
    expect(calls).toHaveLength(0)
  })

  it('treats a hanging DNS resolution on a redirect hop as a timeout bound by the same deadline', async () => {
    const { fetchImpl, calls } = fakeFetch((url) => {
      if (pathnameOf(url) === '/start.xml') {
        return new Response(null, {
          status: 302,
          headers: { location: 'https://redirect-target.example/next.xml' },
        })
      }
      return new Response('<rss></rss>', { status: 200 })
    })

    const error = await fetchFeed({
      url: 'https://example.com/start.xml',
      timeoutMs: 20,
      fetchImpl,
      resolveHostname: (hostname) =>
        hostname === 'example.com' ? Promise.resolve([PUBLIC_ADDRESS]) : new Promise(() => {}),
    }).catch((caught) => caught)

    expect(error).toBeInstanceOf(FeedFetchError)
    expect((error as FeedFetchError).reason).toBe('timeout')
    expect((error as FeedFetchError).retryable).toBe(true)
    expect(calls).toHaveLength(1)
  })

  it('treats a connection error as retryable', async () => {
    const { fetchImpl } = fakeFetch(() => {
      throw new TypeError('connection reset')
    })

    const error = await fetchFeed({ url: 'https://example.com/feed.xml', fetchImpl }).catch(
      (caught) => caught,
    )

    expect(error).toBeInstanceOf(FeedFetchError)
    expect((error as FeedFetchError).reason).toBe('network')
    expect((error as FeedFetchError).retryable).toBe(true)
  })

  it('treats a 5xx response as retryable', async () => {
    const { fetchImpl } = fakeFetch(() => new Response('oops', { status: 503 }))

    const error = await fetchFeed({ url: 'https://example.com/feed.xml', fetchImpl }).catch(
      (caught) => caught,
    )

    expect(error).toBeInstanceOf(FeedFetchError)
    expect((error as FeedFetchError).retryable).toBe(true)
    expect((error as FeedFetchError).status).toBe(503)
  })

  it('treats a 404 as permanent', async () => {
    const { fetchImpl } = fakeFetch(() => new Response('gone', { status: 404 }))

    const error = await fetchFeed({ url: 'https://example.com/feed.xml', fetchImpl }).catch(
      (caught) => caught,
    )

    expect(error).toBeInstanceOf(FeedFetchError)
    expect((error as FeedFetchError).retryable).toBe(false)
    expect((error as FeedFetchError).status).toBe(404)
  })

  it('treats a 410 as permanent', async () => {
    const { fetchImpl } = fakeFetch(() => new Response('gone', { status: 410 }))

    const error = await fetchFeed({ url: 'https://example.com/feed.xml', fetchImpl }).catch(
      (caught) => caught,
    )

    expect((error as FeedFetchError).retryable).toBe(false)
  })

  it('rejects a response that declares an oversized content-length', async () => {
    const { fetchImpl } = fakeFetch(
      () => new Response('small', { status: 200, headers: { 'content-length': '1000000' } }),
    )

    const error = await fetchFeed({
      url: 'https://example.com/feed.xml',
      maxBytes: 10,
      fetchImpl,
    }).catch((caught) => caught)

    expect(error).toBeInstanceOf(FeedFetchError)
    expect((error as FeedFetchError).reason).toBe('oversized')
    expect((error as FeedFetchError).retryable).toBe(false)
  })

  it('aborts a streamed body that exceeds the size limit with no content-length', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('x'.repeat(20)))
        controller.enqueue(new TextEncoder().encode('x'.repeat(20)))
        controller.close()
      },
    })
    const { fetchImpl } = fakeFetch(
      () => new Response(stream, { status: 200, headers: { 'content-type': 'text/xml' } }),
    )

    const error = await fetchFeed({
      url: 'https://example.com/feed.xml',
      maxBytes: 25,
      fetchImpl,
    }).catch((caught) => caught)

    expect(error).toBeInstanceOf(FeedFetchError)
    expect((error as FeedFetchError).reason).toBe('oversized')
    expect((error as FeedFetchError).retryable).toBe(false)
  })

  it('follows a redirect up to the configured depth', async () => {
    const { fetchImpl, calls } = fakeFetch((url) => {
      if (pathnameOf(url) === '/old.xml') {
        return new Response(null, {
          status: 301,
          headers: { location: 'https://example.com/new.xml' },
        })
      }
      return new Response('<rss></rss>', {
        status: 200,
        headers: { 'content-type': 'application/xml' },
      })
    })

    const result = await fetchFeed({
      url: 'https://example.com/old.xml',
      maxRedirects: 2,
      fetchImpl,
    })

    expect(result).toEqual({
      status: 'fetched',
      body: '<rss></rss>',
      contentType: 'application/xml',
      etag: null,
      lastModified: null,
    })
    // Both hops connect to the resolved address; the hostname each hop was
    // logically addressed to is what pathnameOf/the Host header carry.
    expect(calls.map((call) => pathnameOf(call.url))).toEqual(['/old.xml', '/new.xml'])
    expect(calls.map((call) => call.url)).toEqual([
      `https://${PUBLIC_ADDRESS}/old.xml`,
      `https://${PUBLIC_ADDRESS}/new.xml`,
    ])
  })

  it('refuses to follow redirects past the configured depth', async () => {
    let hop = 0
    const { fetchImpl } = fakeFetch(() => {
      hop += 1
      return new Response(null, {
        status: 302,
        headers: { location: `https://example.com/hop-${hop}` },
      })
    })

    const error = await fetchFeed({
      url: 'https://example.com/start.xml',
      maxRedirects: 2,
      fetchImpl,
    }).catch((caught) => caught)

    expect(error).toBeInstanceOf(FeedFetchError)
    expect((error as FeedFetchError).reason).toBe('too-many-redirects')
    expect((error as FeedFetchError).retryable).toBe(false)
  })

  it('refuses a non-http(s) scheme without making a request', async () => {
    const { fetchImpl, calls } = fakeFetch(() => new Response('unreachable', { status: 200 }))

    const error = await fetchFeed({ url: 'ftp://example.com/feed.xml', fetchImpl }).catch(
      (caught) => caught,
    )

    expect(error).toBeInstanceOf(FeedFetchError)
    expect((error as FeedFetchError).reason).toBe('invalid-scheme')
    expect((error as FeedFetchError).retryable).toBe(false)
    expect(calls).toHaveLength(0)
  })

  it('refuses a malformed url without making a request', async () => {
    const { fetchImpl, calls } = fakeFetch(() => new Response('unreachable', { status: 200 }))

    const error = await fetchFeed({ url: 'not a url', fetchImpl }).catch((caught) => caught)

    expect(error).toBeInstanceOf(FeedFetchError)
    expect((error as FeedFetchError).reason).toBe('invalid-scheme')
    expect(calls).toHaveLength(0)
  })

  it('refuses a redirect to a non-http(s) scheme', async () => {
    const { fetchImpl } = fakeFetch(
      () => new Response(null, { status: 302, headers: { location: 'file:///etc/passwd' } }),
    )

    const error = await fetchFeed({ url: 'https://example.com/start.xml', fetchImpl }).catch(
      (caught) => caught,
    )

    expect(error).toBeInstanceOf(FeedFetchError)
    expect((error as FeedFetchError).reason).toBe('invalid-scheme')
  })

  it('refuses a loopback address without making a request', async () => {
    const { fetchImpl, calls } = fakeFetch(() => new Response('unreachable', { status: 200 }))

    const error = await fetchFeedImpl({ url: 'http://127.0.0.1/feed.xml', fetchImpl }).catch(
      (caught) => caught,
    )

    expect(error).toBeInstanceOf(FeedFetchError)
    expect((error as FeedFetchError).reason).toBe('private-address')
    expect((error as FeedFetchError).retryable).toBe(false)
    expect(calls).toHaveLength(0)
  })

  it('refuses a link-local address, including the cloud metadata endpoint', async () => {
    const { fetchImpl, calls } = fakeFetch(() => new Response('unreachable', { status: 200 }))

    const error = await fetchFeedImpl({
      url: 'http://169.254.169.254/latest/meta-data/',
      fetchImpl,
    }).catch((caught) => caught)

    expect(error).toBeInstanceOf(FeedFetchError)
    expect((error as FeedFetchError).reason).toBe('private-address')
    expect((error as FeedFetchError).retryable).toBe(false)
    expect(calls).toHaveLength(0)
  })

  it('refuses a private-range address without making a request', async () => {
    const { fetchImpl, calls } = fakeFetch(() => new Response('unreachable', { status: 200 }))

    const error = await fetchFeedImpl({ url: 'http://10.0.0.5/feed.xml', fetchImpl }).catch(
      (caught) => caught,
    )

    expect(error).toBeInstanceOf(FeedFetchError)
    expect((error as FeedFetchError).reason).toBe('private-address')
    expect((error as FeedFetchError).retryable).toBe(false)
    expect(calls).toHaveLength(0)
  })

  it('refuses a shared/carrier-grade NAT address (100.64.0.0/10)', async () => {
    const { fetchImpl, calls } = fakeFetch(() => new Response('unreachable', { status: 200 }))

    const error = await fetchFeedImpl({ url: 'http://100.64.0.5/feed.xml', fetchImpl }).catch(
      (caught) => caught,
    )

    expect(error).toBeInstanceOf(FeedFetchError)
    expect((error as FeedFetchError).reason).toBe('private-address')
    expect((error as FeedFetchError).retryable).toBe(false)
    expect(calls).toHaveLength(0)
  })

  it('refuses an IPv6 loopback address', async () => {
    const { fetchImpl, calls } = fakeFetch(() => new Response('unreachable', { status: 200 }))

    const error = await fetchFeedImpl({ url: 'http://[::1]/feed.xml', fetchImpl }).catch(
      (caught) => caught,
    )

    expect(error).toBeInstanceOf(FeedFetchError)
    expect((error as FeedFetchError).reason).toBe('private-address')
    expect((error as FeedFetchError).retryable).toBe(false)
    expect(calls).toHaveLength(0)
  })

  it('refuses an IPv6 link-local address', async () => {
    const { fetchImpl, calls } = fakeFetch(() => new Response('unreachable', { status: 200 }))

    const error = await fetchFeedImpl({ url: 'http://[fe80::1]/feed.xml', fetchImpl }).catch(
      (caught) => caught,
    )

    expect(error).toBeInstanceOf(FeedFetchError)
    expect((error as FeedFetchError).reason).toBe('private-address')
    expect((error as FeedFetchError).retryable).toBe(false)
    expect(calls).toHaveLength(0)
  })

  it('refuses an IPv4-mapped IPv6 address', async () => {
    const { fetchImpl, calls } = fakeFetch(() => new Response('unreachable', { status: 200 }))

    const error = await fetchFeedImpl({
      url: 'http://[::ffff:127.0.0.1]/feed.xml',
      fetchImpl,
    }).catch((caught) => caught)

    expect(error).toBeInstanceOf(FeedFetchError)
    expect((error as FeedFetchError).reason).toBe('private-address')
    expect((error as FeedFetchError).retryable).toBe(false)
    expect(calls).toHaveLength(0)
  })

  it('refuses a deprecated IPv4-compatible IPv6 address (::/96) embedding a private address', async () => {
    const { fetchImpl, calls } = fakeFetch(() => new Response('unreachable', { status: 200 }))

    const error = await fetchFeedImpl({ url: 'http://[::127.0.0.1]/feed.xml', fetchImpl }).catch(
      (caught) => caught,
    )

    expect(error).toBeInstanceOf(FeedFetchError)
    expect((error as FeedFetchError).reason).toBe('private-address')
    expect((error as FeedFetchError).retryable).toBe(false)
    expect(calls).toHaveLength(0)
  })

  it('refuses a 6to4 address (2002::/16) embedding a private address', async () => {
    const { fetchImpl, calls } = fakeFetch(() => new Response('unreachable', { status: 200 }))

    const error = await fetchFeedImpl({
      url: 'http://[2002:c0a8:0101::]/feed.xml',
      fetchImpl,
    }).catch((caught) => caught)

    expect(error).toBeInstanceOf(FeedFetchError)
    expect((error as FeedFetchError).reason).toBe('private-address')
    expect((error as FeedFetchError).retryable).toBe(false)
    expect(calls).toHaveLength(0)
  })

  it('refuses a NAT64 well-known-prefix address (64:ff9b::/96) embedding the cloud metadata address', async () => {
    const { fetchImpl, calls } = fakeFetch(() => new Response('unreachable', { status: 200 }))

    const error = await fetchFeedImpl({
      url: 'http://[64:ff9b::a9fe:a9fe]/feed.xml',
      fetchImpl,
    }).catch((caught) => caught)

    expect(error).toBeInstanceOf(FeedFetchError)
    expect((error as FeedFetchError).reason).toBe('private-address')
    expect((error as FeedFetchError).retryable).toBe(false)
    expect(calls).toHaveLength(0)
  })

  it('refuses a hostname that resolves to a private address', async () => {
    const { fetchImpl, calls } = fakeFetch(() => new Response('unreachable', { status: 200 }))

    const error = await fetchFeedImpl({
      url: 'http://internal.example/feed.xml',
      fetchImpl,
      resolveHostname: () => Promise.resolve(['192.168.1.10']),
    }).catch((caught) => caught)

    expect(error).toBeInstanceOf(FeedFetchError)
    expect((error as FeedFetchError).reason).toBe('private-address')
    expect(calls).toHaveLength(0)
  })

  it('refuses a hostname that resolves to a private IPv6 (unique-local) address', async () => {
    const { fetchImpl, calls } = fakeFetch(() => new Response('unreachable', { status: 200 }))

    const error = await fetchFeedImpl({
      url: 'http://internal.example/feed.xml',
      fetchImpl,
      resolveHostname: () => Promise.resolve(['fd00::1']),
    }).catch((caught) => caught)

    expect(error).toBeInstanceOf(FeedFetchError)
    expect((error as FeedFetchError).reason).toBe('private-address')
    expect(calls).toHaveLength(0)
  })

  it('refuses a redirect from a public url to a private address', async () => {
    const { fetchImpl, calls } = fakeFetch((url) => {
      if (pathnameOf(url) === '/start.xml') {
        return new Response(null, {
          status: 302,
          headers: { location: 'http://169.254.169.254/latest/meta-data/' },
        })
      }
      return new Response('unreachable', { status: 200 })
    })

    const error = await fetchFeed({ url: 'https://example.com/start.xml', fetchImpl }).catch(
      (caught) => caught,
    )

    expect(error).toBeInstanceOf(FeedFetchError)
    expect((error as FeedFetchError).reason).toBe('private-address')
    expect((error as FeedFetchError).retryable).toBe(false)
    expect(calls).toHaveLength(1)
  })

  it('allows a normal public feed through unaffected', async () => {
    const { fetchImpl } = fakeFetch(
      () => new Response('<rss></rss>', { status: 200, headers: { 'content-type': 'text/xml' } }),
    )

    const result = await fetchFeed({ url: 'https://example.com/feed.xml', fetchImpl })

    expect(result).toEqual({
      status: 'fetched',
      body: '<rss></rss>',
      contentType: 'text/xml',
      etag: null,
      lastModified: null,
    })
  })

  it('shares one deadline across every redirect hop instead of resetting it per hop', async () => {
    const { fetchImpl, calls } = fakeFetch((url) => {
      if (pathnameOf(url) === '/start.xml') {
        return new Response(null, {
          status: 302,
          headers: { location: 'https://example.com/next.xml' },
        })
      }
      return new Response('<rss></rss>', { status: 200 })
    })

    await fetchFeed({ url: 'https://example.com/start.xml', fetchImpl })

    expect(calls).toHaveLength(2)
    expect(calls[0]?.init?.signal).toBe(calls[1]?.init?.signal)
  })

  it('cancels a superseded redirect response body before following the next hop', async () => {
    let cancelled = false
    const redirectBody = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true
      },
    })
    const { fetchImpl } = fakeFetch((url) => {
      if (pathnameOf(url) === '/start.xml') {
        return new Response(redirectBody, {
          status: 302,
          headers: { location: 'https://example.com/next.xml' },
        })
      }
      return new Response('<rss></rss>', { status: 200 })
    })

    await fetchFeed({ url: 'https://example.com/start.xml', fetchImpl })

    expect(cancelled).toBe(true)
  })
})

/**
 * `fetchFeed` pins the connection to the resolved address and restores the
 * original hostname by setting a `Host` header and `tls.serverName` on the
 * request passed to `fetchImpl` (see `assertSafeUrl` in
 * `../src/lib/feed-fetcher.ts`). Every test above fakes `fetchImpl`, so it
 * can only assert on the object handed to it — it cannot tell whether the
 * real runtime actually sends that `Host` header on the wire rather than
 * silently dropping it, which the Fetch spec allows for a small set of
 * "forbidden" header names that includes `Host`.
 *
 * `fetchFeed` itself cannot be exercised against a real local server here:
 * `assertSafeUrl` correctly refuses to connect to loopback/private
 * addresses, and any server this test process can stand up is reachable
 * only on one of those. So this pins the narrower, real assumption
 * `fetchFeed`'s pinning depends on — that Bun's global `fetch` honors a
 * `Host` header override when the request URL is a bare IP literal — against
 * the real, unmocked `fetch`, with no `fetchImpl` fake involved.
 *
 * This was also verified manually against a real CDN-fronted HTTPS origin
 * (resolving `example.com` to its own IP and fetching that IP directly with
 * `Host` and `tls.serverName` overridden to `example.com`): the request
 * returned the correct site, while the same request without the overrides
 * failed outright. That confirms `tls.serverName` is honored for SNI and
 * certificate validation the same way `Host` is honored below.
 */
describe('the real fetch honors a Host header override for an IP-literal request', () => {
  it('delivers the overridden Host header to the origin server instead of dropping it', async () => {
    let seenHost: string | undefined
    const server = http.createServer((req, res) => {
      seenHost = req.headers.host
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('ok')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (typeof address !== 'object' || address === null) throw new Error('server did not bind')

    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/`, {
        headers: { Host: 'origin.internal.test' },
      })
      await response.text()

      expect(seenHost).toBe('origin.internal.test')
    } finally {
      server.close()
    }
  })
})
