import { describe, expect, it } from 'bun:test'
import { UnrecoverableError } from '@newsdeck/jobs'
import { createLogger } from '@newsdeck/logger'
import { createSourcesFetchHandler } from '../src/handlers/sources-fetch.ts'
import type {
  RecordFetchOutcomeInput,
  SourceFetchTarget,
  SourcesRepository,
} from '../src/modules/sources/repository.ts'

function collectingLogger() {
  const records: Array<Record<string, unknown>> = []
  const logger = createLogger({
    service: 'worker-test',
    instanceId: 'worker-test',
    level: 'debug',
    destination: {
      write(chunk: string) {
        for (const line of chunk.split('\n')) {
          if (line.trim().length > 0) records.push(JSON.parse(line) as Record<string, unknown>)
        }
      },
    },
  })
  return { logger, records }
}

function fakeRepository(source: SourceFetchTarget | null) {
  const outcomes: Array<{ id: string; outcome: RecordFetchOutcomeInput }> = []
  const repository: SourcesRepository = {
    async findFetchTarget() {
      return source
    },
    async recordFetchOutcome(id, outcome) {
      outcomes.push({ id, outcome })
    },
  }
  return { repository, outcomes }
}

function fakeFetch(impl: () => Promise<Response> | Response) {
  return (async (..._args: Parameters<typeof fetch>) => impl()) as typeof fetch
}

/** A public address, so tests never touch real DNS. */
const resolveHostname = () => Promise.resolve(['93.184.216.34'])

const context = (logger: ReturnType<typeof collectingLogger>['logger']) => ({
  logger,
  instanceId: 'worker-test',
})

describe('createSourcesFetchHandler', () => {
  it('records a successful fetch and its validators', async () => {
    const source: SourceFetchTarget = {
      id: 'source-1',
      feedUrl: 'https://example.com/feed.xml',
      etag: null,
      lastModified: null,
    }
    const { repository, outcomes } = fakeRepository(source)
    const { logger, records } = collectingLogger()
    const handler = createSourcesFetchHandler({
      repository,
      resolveHostname,
      fetchImpl: fakeFetch(
        () =>
          new Response('<rss></rss>', {
            status: 200,
            headers: { 'content-type': 'application/rss+xml', etag: '"v2"' },
          }),
      ),
    })

    await handler.process({ sourceId: 'source-1' }, context(logger))

    expect(outcomes).toEqual([
      { id: 'source-1', outcome: { lastError: null, etag: '"v2"', lastModified: null } },
    ])
    expect(records.find((r) => r.msg === 'source fetch completed')).toMatchObject({
      sourceId: 'source-1',
      outcome: 'fetched',
    })
  })

  it('records a 304 as not-modified without touching stored validators', async () => {
    const source: SourceFetchTarget = {
      id: 'source-1',
      feedUrl: 'https://example.com/feed.xml',
      etag: '"v1"',
      lastModified: 'Mon, 01 Jan 2024 00:00:00 GMT',
    }
    const { repository, outcomes } = fakeRepository(source)
    const { logger, records } = collectingLogger()
    const handler = createSourcesFetchHandler({
      repository,
      resolveHostname,
      fetchImpl: fakeFetch(() => new Response(null, { status: 304 })),
    })

    await handler.process({ sourceId: 'source-1' }, context(logger))

    expect(outcomes).toEqual([{ id: 'source-1', outcome: { lastError: null } }])
    expect(records.find((r) => r.msg === 'source fetch completed')).toMatchObject({
      outcome: 'not-modified',
    })
  })

  it('raises UnrecoverableError and records the error on a permanent failure', async () => {
    const source: SourceFetchTarget = {
      id: 'source-1',
      feedUrl: 'https://example.com/feed.xml',
      etag: null,
      lastModified: null,
    }
    const { repository, outcomes } = fakeRepository(source)
    const { logger, records } = collectingLogger()
    const handler = createSourcesFetchHandler({
      repository,
      resolveHostname,
      fetchImpl: fakeFetch(() => new Response('gone', { status: 404 })),
    })

    await expect(handler.process({ sourceId: 'source-1' }, context(logger))).rejects.toBeInstanceOf(
      UnrecoverableError,
    )

    expect(outcomes).toHaveLength(1)
    expect(outcomes[0]?.outcome.lastError).toContain('404')
    expect(records.find((r) => r.msg === 'source fetch failed permanently')).toBeDefined()
  })

  it('rethrows a plain error and records it on a transient failure', async () => {
    const source: SourceFetchTarget = {
      id: 'source-1',
      feedUrl: 'https://example.com/feed.xml',
      etag: null,
      lastModified: null,
    }
    const { repository, outcomes } = fakeRepository(source)
    const { logger, records } = collectingLogger()
    const handler = createSourcesFetchHandler({
      repository,
      resolveHostname,
      fetchImpl: fakeFetch(() => new Response('oops', { status: 503 })),
    })

    const error = await handler
      .process({ sourceId: 'source-1' }, context(logger))
      .catch((caught) => caught)

    expect(error).not.toBeInstanceOf(UnrecoverableError)
    expect(outcomes[0]?.outcome.lastError).toContain('503')
    expect(records.find((r) => r.msg === 'source fetch failed, will retry')).toBeDefined()
  })

  it('raises UnrecoverableError without fetching when the source no longer exists', async () => {
    const { repository, outcomes } = fakeRepository(null)
    const { logger } = collectingLogger()
    let fetchCalled = false
    const handler = createSourcesFetchHandler({
      repository,
      resolveHostname,
      fetchImpl: fakeFetch(() => {
        fetchCalled = true
        return new Response('', { status: 200 })
      }),
    })

    await expect(handler.process({ sourceId: 'missing' }, context(logger))).rejects.toBeInstanceOf(
      UnrecoverableError,
    )

    expect(fetchCalled).toBe(false)
    expect(outcomes).toHaveLength(0)
  })
})
