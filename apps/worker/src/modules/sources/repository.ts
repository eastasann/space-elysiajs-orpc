import type { DatabaseHandle } from '@newsdeck/db'
import { sources } from '@newsdeck/db/schema'
import { eq } from 'drizzle-orm'

export interface SourceFetchTarget {
  id: string
  feedUrl: string
  etag: string | null
  lastModified: string | null
}

export interface RecordFetchOutcomeInput {
  /** Omitted on failure: a failed fetch must not erase validators from the last success. */
  etag?: string | null
  lastModified?: string | null
  /** `null` clears the error left by a previous attempt. */
  lastError: string | null
}

/**
 * Persistence access for the `sources.fetch` job.
 *
 * SQL and Drizzle imports live here, and nowhere above — mirrors
 * `apps/api/src/modules/sources/repository.ts`. Kept separate from that file
 * because the worker is a different process with its own database pool; apps
 * do not import each other's modules.
 */
export interface SourcesRepository {
  findFetchTarget(id: string): Promise<SourceFetchTarget | null>
  recordFetchOutcome(id: string, outcome: RecordFetchOutcomeInput): Promise<void>
}

export function createSourcesRepository(handle: DatabaseHandle): SourcesRepository {
  return {
    async findFetchTarget(id) {
      const [row] = await handle.db
        .select({
          id: sources.id,
          feedUrl: sources.feedUrl,
          etag: sources.etag,
          lastModified: sources.lastModified,
        })
        .from(sources)
        .where(eq(sources.id, id))
        .limit(1)
      return row ?? null
    },

    async recordFetchOutcome(id, outcome) {
      await handle.db
        .update(sources)
        .set({
          lastFetchedAt: new Date(),
          lastError: outcome.lastError,
          ...(outcome.etag !== undefined ? { etag: outcome.etag } : {}),
          ...(outcome.lastModified !== undefined ? { lastModified: outcome.lastModified } : {}),
          updatedAt: new Date(),
        })
        .where(eq(sources.id, id))
    },
  }
}
