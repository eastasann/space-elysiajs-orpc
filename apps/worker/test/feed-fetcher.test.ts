import { describe, expect, it } from 'bun:test'
import { FeedFetchError, fetchFeed } from '../src/lib/feed-fetcher.ts'

type FetchCall = { url: string; init: RequestInit | undefined }

function fakeFetch(impl: (url: string, init?: RequestInit) => Promise<Response> | Response) {
  const calls: FetchCall[] = []
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init })
    return impl(String(input), init)
  }) as typeof fetch
  return { fetchImpl, calls }
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
      if (url === 'https://example.com/old.xml') {
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
    expect(calls.map((call) => call.url)).toEqual([
      'https://example.com/old.xml',
      'https://example.com/new.xml',
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
})
