import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import type { DatabaseHandle } from '@newsdeck/db'
import { createDatabase, runMigrations } from '@newsdeck/db'
import { articles, type NewArticle, sources } from '@newsdeck/db/schema'
import { sql } from 'drizzle-orm'
import {
  type ArticlesRepository,
  createArticlesRepository,
} from '../src/modules/articles/repository.ts'

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL

/**
 * Integration coverage for the articles repository. Requires a real
 * PostgreSQL instance; see docs/development.md#testing. Skipped — loudly —
 * when TEST_DATABASE_URL is unset so that `bun run test` stays usable
 * offline.
 */
describe.skipIf(!TEST_DATABASE_URL)('articles repository', () => {
  let handle: DatabaseHandle
  let repository: ArticlesRepository
  let sourceId: string

  beforeAll(async () => {
    handle = createDatabase({ url: TEST_DATABASE_URL as string, maxConnections: 2 })
    await runMigrations(handle)
    repository = createArticlesRepository(handle)
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

  function articleInput(overrides: Partial<NewArticle> = {}): NewArticle {
    return {
      sourceId,
      url: 'https://example.test/a',
      canonicalUrl: 'https://example.test/a',
      title: 'Title',
      summary: null,
      author: null,
      imageUrl: null,
      contentHash: 'hash-a',
      publishedAt: null,
      fetchedAt: new Date(),
      ...overrides,
    }
  }

  it('inserts an article and returns the created row', async () => {
    await reset()

    const created = await repository.insert(articleInput())

    expect(created.canonicalUrl).toBe('https://example.test/a')
    expect(created.contentHash).toBe('hash-a')
    expect(created.sourceId).toBe(sourceId)
  })

  it('rejects a second insert with the same canonical url', async () => {
    await reset()
    await repository.insert(articleInput())

    await expect(
      repository.insert(
        articleInput({ url: 'https://example.test/a?tracked=1', contentHash: 'hash-b' }),
      ),
    ).rejects.toThrow()
  })

  it('finds a match by canonical url', async () => {
    await reset()
    const created = await repository.insert(articleInput())

    const matches = await repository.findMatches([
      { canonicalUrl: 'https://example.test/a', contentHash: 'unrelated-hash' },
    ])

    expect(matches).toEqual([
      { id: created.id, canonicalUrl: 'https://example.test/a', contentHash: 'hash-a' },
    ])
  })

  it('finds a match by content hash even when the url differs', async () => {
    await reset()
    const created = await repository.insert(articleInput())

    const matches = await repository.findMatches([
      { canonicalUrl: 'https://example.test/somewhere-else', contentHash: 'hash-a' },
    ])

    expect(matches).toEqual([
      { id: created.id, canonicalUrl: 'https://example.test/a', contentHash: 'hash-a' },
    ])
  })

  it('returns no matches when nothing overlaps', async () => {
    await reset()
    await repository.insert(articleInput())

    const matches = await repository.findMatches([
      { canonicalUrl: 'https://example.test/nowhere', contentHash: 'nowhere-hash' },
    ])

    expect(matches).toEqual([])
  })

  it('resolves every query in a single batch', async () => {
    await reset()
    const first = await repository.insert(articleInput())
    const second = await repository.insert(
      articleInput({
        url: 'https://example.test/b',
        canonicalUrl: 'https://example.test/b',
        contentHash: 'hash-b',
      }),
    )

    const matches = await repository.findMatches([
      { canonicalUrl: 'https://example.test/a', contentHash: 'irrelevant' },
      { canonicalUrl: 'https://example.test/nowhere', contentHash: 'hash-b' },
    ])

    expect(matches.map((match) => match.id).sort()).toEqual([first.id, second.id].sort())
  })

  it('returns an empty array without a query when given no candidates', async () => {
    await reset()

    expect(await repository.findMatches([])).toEqual([])
  })
})
