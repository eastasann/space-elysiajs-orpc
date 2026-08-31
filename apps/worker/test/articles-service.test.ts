import { describe, expect, it } from 'bun:test'
import type { Article, NewArticle } from '@newsdeck/db/schema'
import type { ArticleCandidate } from '../src/lib/feed-parser.ts'
import type {
  ArticleMatch,
  ArticleMatchQuery,
  ArticlesRepository,
} from '../src/modules/articles/repository.ts'
import { createArticlesService } from '../src/modules/articles/service.ts'

let sequence = 0

function fakeCandidate(overrides: Partial<ArticleCandidate> = {}): ArticleCandidate {
  sequence += 1
  return {
    url: `https://example.test/article-${sequence}`,
    canonicalUrl: `https://example.test/article-${sequence}`,
    title: `Article ${sequence}`,
    summary: null,
    author: null,
    imageUrl: null,
    contentHash: `hash-${sequence}`,
    publishedAt: null,
    ...overrides,
  }
}

function fakeArticle(overrides: Partial<Article> = {}): Article {
  sequence += 1
  const now = new Date()
  return {
    id: `article-${sequence}`,
    sourceId: 'source-1',
    categoryId: null,
    url: `https://example.test/article-${sequence}`,
    canonicalUrl: `https://example.test/article-${sequence}`,
    title: `Article ${sequence}`,
    summary: null,
    author: null,
    imageUrl: null,
    contentHash: `hash-${sequence}`,
    publishedAt: null,
    fetchedAt: now,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

/**
 * Shaped the way postgres.js reports a unique violation, wrapped the way
 * Drizzle wraps it — see `packages/db/test/migrations.integration.test.ts`.
 */
function fakeUniqueViolation(): Error {
  const error = new Error('duplicate key value violates unique constraint') as Error & {
    cause: { code: string; constraint_name: string }
  }
  error.cause = { code: '23505', constraint_name: 'articles_canonical_url_unique' }
  return error
}

function isUniqueViolation(error: Error): boolean {
  return (error as { cause?: { code?: string } }).cause?.code === '23505'
}

interface FakeArticlesRepository extends ArticlesRepository {
  rows: Article[]
  /**
   * Makes the next `insert` call throw this error instead of writing. A
   * unique-violation additionally lands a row first — modelling a concurrent
   * insert that won the race: the constraint only fails once the racing row
   * already exists.
   */
  failNextInsertWith: Error | null
}

function fakeArticlesRepository(seed: Article[] = []): FakeArticlesRepository {
  const repository: FakeArticlesRepository = {
    rows: [...seed],
    failNextInsertWith: null,

    async findMatches(queries: ArticleMatchQuery[]): Promise<ArticleMatch[]> {
      const urls = new Set(queries.map((query) => query.canonicalUrl))
      const hashes = new Set(queries.map((query) => query.contentHash))
      return repository.rows
        .filter((row) => urls.has(row.canonicalUrl) || hashes.has(row.contentHash))
        .map((row) => ({
          id: row.id,
          canonicalUrl: row.canonicalUrl,
          contentHash: row.contentHash,
        }))
    },

    async insert(input: NewArticle): Promise<Article> {
      sequence += 1

      if (repository.failNextInsertWith !== null) {
        const error = repository.failNextInsertWith
        repository.failNextInsertWith = null
        if (isUniqueViolation(error)) {
          repository.rows.push(fakeArticle({ id: `race-winner-${sequence}`, ...input }))
        }
        throw error
      }

      const row = fakeArticle({ id: `article-${sequence}`, ...input })
      repository.rows.push(row)
      return row
    },
  }

  return repository
}

describe('dedupeAndPersist', () => {
  it('inserts a genuinely new candidate', async () => {
    const repository = fakeArticlesRepository()
    const service = createArticlesService(repository)
    const candidate = fakeCandidate()

    const result = await service.dedupeAndPersist({
      sourceId: 'source-1',
      fetchedAt: new Date(),
      candidates: [candidate],
    })

    expect(result.insertedCount).toBe(1)
    expect(result.existingCount).toBe(0)
    expect(result.duplicateInBatchCount).toBe(0)
    expect(result.outcomes[0]?.outcome.status).toBe('inserted')
    expect(repository.rows).toHaveLength(1)
    expect(repository.rows[0]?.sourceId).toBe('source-1')
  })

  it('treats an exact canonical_url match as the same article', async () => {
    const existing = fakeArticle({
      canonicalUrl: 'https://example.test/existing',
      contentHash: 'existing-hash',
    })
    const repository = fakeArticlesRepository([existing])
    const service = createArticlesService(repository)
    const candidate = fakeCandidate({
      canonicalUrl: 'https://example.test/existing',
      contentHash: 'a-different-hash',
    })

    const result = await service.dedupeAndPersist({
      sourceId: 'source-1',
      fetchedAt: new Date(),
      candidates: [candidate],
    })

    expect(result.insertedCount).toBe(0)
    expect(result.existingCount).toBe(1)
    expect(result.outcomes[0]?.outcome).toEqual({
      status: 'existing',
      reason: 'canonical-url',
      existingArticleId: existing.id,
    })
    expect(repository.rows).toHaveLength(1)
  })

  it('treats a content_hash match as the same article even when the url differs', async () => {
    const existing = fakeArticle({
      canonicalUrl: 'https://example.test/original',
      contentHash: 'shared-hash',
    })
    const repository = fakeArticlesRepository([existing])
    const service = createArticlesService(repository)
    const candidate = fakeCandidate({
      canonicalUrl: 'https://example.test/syndicated-elsewhere',
      contentHash: 'shared-hash',
    })

    const result = await service.dedupeAndPersist({
      sourceId: 'source-1',
      fetchedAt: new Date(),
      candidates: [candidate],
    })

    expect(result.insertedCount).toBe(0)
    expect(result.existingCount).toBe(1)
    expect(result.outcomes[0]?.outcome).toEqual({
      status: 'existing',
      reason: 'content-hash',
      existingArticleId: existing.id,
    })
    expect(repository.rows).toHaveLength(1)
  })

  it('collapses duplicates within a single batch before any database write', async () => {
    const repository = fakeArticlesRepository()
    const service = createArticlesService(repository)
    const original = fakeCandidate()
    const sameUrl = fakeCandidate({ canonicalUrl: original.canonicalUrl })
    const sameHashDifferentUrl = fakeCandidate({ contentHash: sameUrl.contentHash })

    const result = await service.dedupeAndPersist({
      sourceId: 'source-1',
      fetchedAt: new Date(),
      candidates: [original, sameUrl, sameHashDifferentUrl],
    })

    expect(result.insertedCount).toBe(1)
    expect(result.duplicateInBatchCount).toBe(2)
    expect(repository.rows).toHaveLength(1)

    expect(result.outcomes[0]?.outcome.status).toBe('inserted')
    expect(result.outcomes[1]?.outcome).toEqual({
      status: 'duplicate-in-batch',
      reason: 'canonical-url',
      duplicateOfIndex: 0,
    })
    // sameHashDifferentUrl only shares its hash with sameUrl (index 1), but
    // sameUrl was itself folded into index 0 — transitivity should follow it there.
    expect(result.outcomes[2]?.outcome).toEqual({
      status: 'duplicate-in-batch',
      reason: 'content-hash',
      duplicateOfIndex: 0,
    })
  })

  it('merges two independently-established batch groups when a later candidate bridges them', async () => {
    const repository = fakeArticlesRepository()
    const service = createArticlesService(repository)
    // groupA and groupB share nothing with each other, so each becomes its
    // own representative — until bridge arrives sharing a canonical_url with
    // groupA and a content_hash with groupB, which should fold all three
    // into a single group and a single insert.
    const groupA = fakeCandidate()
    const groupB = fakeCandidate()
    const bridge = fakeCandidate({
      canonicalUrl: groupA.canonicalUrl,
      contentHash: groupB.contentHash,
    })

    const result = await service.dedupeAndPersist({
      sourceId: 'source-1',
      fetchedAt: new Date(),
      candidates: [groupA, groupB, bridge],
    })

    expect(result.insertedCount).toBe(1)
    expect(result.duplicateInBatchCount).toBe(2)
    expect(repository.rows).toHaveLength(1)

    expect(result.outcomes[0]?.outcome.status).toBe('inserted')
    expect(result.outcomes[1]?.outcome).toEqual({
      status: 'duplicate-in-batch',
      reason: 'content-hash',
      duplicateOfIndex: 0,
    })
    expect(result.outcomes[2]?.outcome).toEqual({
      status: 'duplicate-in-batch',
      reason: 'canonical-url',
      duplicateOfIndex: 0,
    })
  })

  it('reports a genuinely new candidate alongside duplicates without dropping either', async () => {
    const repository = fakeArticlesRepository()
    const service = createArticlesService(repository)
    const first = fakeCandidate()
    const duplicateOfFirst = fakeCandidate({ canonicalUrl: first.canonicalUrl })
    const genuinelyNew = fakeCandidate()

    const result = await service.dedupeAndPersist({
      sourceId: 'source-1',
      fetchedAt: new Date(),
      candidates: [first, duplicateOfFirst, genuinelyNew],
    })

    expect(result.insertedCount).toBe(2)
    expect(result.duplicateInBatchCount).toBe(1)
    expect(result.outcomes.map((entry) => entry.outcome.status)).toEqual([
      'inserted',
      'duplicate-in-batch',
      'inserted',
    ])
  })

  it('treats a lost insert race as already existing rather than as an error', async () => {
    const repository = fakeArticlesRepository()
    repository.failNextInsertWith = fakeUniqueViolation()
    const service = createArticlesService(repository)
    const candidate = fakeCandidate()

    const result = await service.dedupeAndPersist({
      sourceId: 'source-1',
      fetchedAt: new Date(),
      candidates: [candidate],
    })

    expect(result.insertedCount).toBe(0)
    expect(result.existingCount).toBe(1)
    expect(result.outcomes[0]?.outcome).toMatchObject({ status: 'existing', reason: 'race' })
    // Only the racing insert's own row landed — this call never wrote one.
    expect(repository.rows).toHaveLength(1)
  })

  it('does not swallow an unrelated insert failure', async () => {
    const repository = fakeArticlesRepository()
    const unrelated = new Error('connection reset')
    repository.failNextInsertWith = unrelated
    const service = createArticlesService(repository)

    await expect(
      service.dedupeAndPersist({
        sourceId: 'source-1',
        fetchedAt: new Date(),
        candidates: [fakeCandidate()],
      }),
    ).rejects.toBe(unrelated)
    expect(repository.rows).toHaveLength(0)
  })
})
