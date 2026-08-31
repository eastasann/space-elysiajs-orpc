import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import type { DatabaseHandle } from '@newsdeck/db'
import { createDatabase, runMigrations } from '@newsdeck/db'
import { articles, sources } from '@newsdeck/db/schema'
import { count, sql } from 'drizzle-orm'
import type { ArticleCandidate } from '../src/lib/feed-parser.ts'
import { createArticlesRepository } from '../src/modules/articles/repository.ts'
import { createArticlesService } from '../src/modules/articles/service.ts'

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL

/**
 * Integration coverage for the dedupe/persist service against a real
 * PostgreSQL instance — the unit suite (`articles-service.test.ts`) proves
 * the decision logic; this proves the unique constraint actually backs it up
 * under real, concurrent writes. Skipped — loudly — when TEST_DATABASE_URL
 * is unset so that `bun run test` stays usable offline.
 */
describe.skipIf(!TEST_DATABASE_URL)('articles service against a live database', () => {
  let handle: DatabaseHandle
  let sourceId: string

  beforeAll(async () => {
    handle = createDatabase({ url: TEST_DATABASE_URL as string, maxConnections: 5 })
    await runMigrations(handle)
  })

  afterAll(async () => {
    if (handle !== undefined) await handle.close()
  })

  async function reset(): Promise<void> {
    await handle.db.execute(sql`truncate table ${articles} restart identity cascade`)
    await handle.db.execute(sql`truncate table ${sources} restart identity cascade`)
    const [source] = await handle.db
      .insert(sources)
      .values({ name: 'Example Feed', feedUrl: 'https://example.test/feed.xml' })
      .returning({ id: sources.id })
    sourceId = (source as { id: string }).id
  }

  async function articleCount(): Promise<number> {
    const [row] = await handle.db.select({ value: count() }).from(articles)
    return row?.value ?? 0
  }

  function candidate(overrides: Partial<ArticleCandidate> = {}): ArticleCandidate {
    return {
      url: 'https://example.test/story',
      canonicalUrl: 'https://example.test/story',
      title: 'A Story',
      summary: null,
      author: null,
      imageUrl: null,
      contentHash: 'story-hash',
      publishedAt: null,
      ...overrides,
    }
  }

  it('ingesting the same batch twice does not grow the article count', async () => {
    await reset()
    const service = createArticlesService(createArticlesRepository(handle))
    const candidates = [
      candidate(),
      candidate({
        url: 'https://example.test/second',
        canonicalUrl: 'https://example.test/second',
        title: 'Second Story',
        contentHash: 'second-hash',
      }),
    ]

    const first = await service.dedupeAndPersist({ sourceId, fetchedAt: new Date(), candidates })
    expect(first.insertedCount).toBe(2)
    expect(await articleCount()).toBe(2)

    const second = await service.dedupeAndPersist({ sourceId, fetchedAt: new Date(), candidates })
    expect(second.insertedCount).toBe(0)
    expect(second.existingCount).toBe(2)
    expect(await articleCount()).toBe(2)
  })

  it('does not create two rows when the same article is ingested concurrently', async () => {
    await reset()
    const serviceA = createArticlesService(createArticlesRepository(handle))
    const serviceB = createArticlesService(createArticlesRepository(handle))
    const candidates = [candidate()]

    const [resultA, resultB] = await Promise.all([
      serviceA.dedupeAndPersist({ sourceId, fetchedAt: new Date(), candidates }),
      serviceB.dedupeAndPersist({ sourceId, fetchedAt: new Date(), candidates }),
    ])

    expect(resultA.insertedCount + resultB.insertedCount).toBe(1)
    expect(resultA.existingCount + resultB.existingCount).toBe(1)
    expect(await articleCount()).toBe(1)
  })
})
