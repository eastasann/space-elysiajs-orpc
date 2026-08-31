import type { DatabaseHandle } from '@newsdeck/db'
import { type Article, articles, type NewArticle } from '@newsdeck/db/schema'
import { inArray, or } from 'drizzle-orm'

/** What a lookup needs to decide whether a candidate is already known. */
export interface ArticleMatchQuery {
  canonicalUrl: string
  contentHash: string
}

/** The identity fields of an existing row a candidate might match. */
export interface ArticleMatch {
  id: string
  canonicalUrl: string
  contentHash: string
}

/**
 * Persistence access for article deduplication.
 *
 * SQL and Drizzle imports live here, and nowhere above — mirrors
 * `apps/worker/src/modules/sources/repository.ts`. The decision of what a
 * match *means* belongs to `./service.ts`; this only answers "does anything
 * already stored match one of these?" and "write this row."
 */
export interface ArticlesRepository {
  /**
   * Existing rows whose `canonical_url` or `content_hash` matches any of the
   * given queries, in a single round trip. Returns only the identity fields a
   * caller needs to decide, not full rows.
   */
  findMatches(queries: ArticleMatchQuery[]): Promise<ArticleMatch[]>
  insert(input: NewArticle): Promise<Article>
}

export function createArticlesRepository(handle: DatabaseHandle): ArticlesRepository {
  return {
    async findMatches(queries) {
      if (queries.length === 0) return []

      const canonicalUrls = queries.map((query) => query.canonicalUrl)
      const contentHashes = queries.map((query) => query.contentHash)

      return handle.db
        .select({
          id: articles.id,
          canonicalUrl: articles.canonicalUrl,
          contentHash: articles.contentHash,
        })
        .from(articles)
        .where(
          or(
            inArray(articles.canonicalUrl, canonicalUrls),
            inArray(articles.contentHash, contentHashes),
          ),
        )
    },

    async insert(input) {
      const [row] = await handle.db.insert(articles).values(input).returning()
      if (row === undefined) throw new Error('insert did not return the created article')
      return row
    },
  }
}
