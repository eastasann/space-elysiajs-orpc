import type { DatabaseHandle } from '@newsdeck/db'
import { type NewSource, type Source, sources } from '@newsdeck/db/schema'
import { asc, count, eq } from 'drizzle-orm'

/** Applied when a caller asks for no page size at all. */
export const DEFAULT_PAGE_SIZE = 20
/** Hard ceiling on page size, so a caller can never force an unbounded scan. */
export const MAX_PAGE_SIZE = 100

export interface ListSourcesOptions {
  /** 1-based. Anything below 1 is treated as 1. */
  page?: number
  /** Clamped to [1, MAX_PAGE_SIZE]. */
  pageSize?: number
}

export interface ListSourcesPage {
  items: Source[]
  total: number
}

export interface UpdateSourceInput {
  name?: string
  feedUrl?: string
  siteUrl?: string | null
}

/**
 * Persistence access for the sources module.
 *
 * SQL and Drizzle imports live here, and nowhere above — see
 * `apps/api/src/modules/system/repository.ts` for the layer this copies.
 */
export interface SourcesRepository {
  list(options?: ListSourcesOptions): Promise<ListSourcesPage>
  findById(id: string): Promise<Source | null>
  findByFeedUrl(feedUrl: string): Promise<Source | null>
  insert(input: NewSource): Promise<Source>
  update(id: string, patch: UpdateSourceInput): Promise<Source | null>
  deactivate(id: string): Promise<Source | null>
}

export function createSourcesRepository(handle: DatabaseHandle): SourcesRepository {
  return {
    async list(options = {}) {
      const pageSize = Math.min(Math.max(options.pageSize ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE)
      const page = Math.max(options.page ?? 1, 1)

      // createdAt alone can tie on a fast bulk insert; id breaks the tie so the
      // order is stable across pages instead of shuffling rows between them.
      const [items, totalRows] = await Promise.all([
        handle.db
          .select()
          .from(sources)
          .orderBy(asc(sources.createdAt), asc(sources.id))
          .limit(pageSize)
          .offset((page - 1) * pageSize),
        handle.db.select({ value: count() }).from(sources),
      ])

      return { items, total: totalRows[0]?.value ?? 0 }
    },

    async findById(id) {
      const [row] = await handle.db.select().from(sources).where(eq(sources.id, id)).limit(1)
      return row ?? null
    },

    async findByFeedUrl(feedUrl) {
      const [row] = await handle.db
        .select()
        .from(sources)
        .where(eq(sources.feedUrl, feedUrl))
        .limit(1)
      return row ?? null
    },

    async insert(input) {
      const [row] = await handle.db.insert(sources).values(input).returning()
      if (row === undefined) throw new Error('insert did not return the created source')
      return row
    },

    async update(id, patch) {
      const [row] = await handle.db
        .update(sources)
        .set({ ...patch, updatedAt: new Date() })
        .where(eq(sources.id, id))
        .returning()
      return row ?? null
    },

    async deactivate(id) {
      const [row] = await handle.db
        .update(sources)
        .set({ isActive: false, updatedAt: new Date() })
        .where(eq(sources.id, id))
        .returning()
      return row ?? null
    },
  }
}
