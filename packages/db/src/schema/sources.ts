import { sql } from 'drizzle-orm'
import { boolean, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'

/**
 * A feed the collector reads from.
 *
 * Fetch bookkeeping (`etag`, `last_modified`, `last_fetched_at`, `last_error`)
 * lives here rather than in its own table: it is one row per source, written
 * by the `sources.fetch` job, and read back by the same job to make the next
 * request conditional.
 */
export const sources = pgTable(
  'sources',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    feedUrl: text('feed_url').notNull(),
    siteUrl: text('site_url'),
    isActive: boolean('is_active').notNull().default(true),
    /** Stored verbatim from the `ETag` response header and echoed on the next fetch. */
    etag: text('etag'),
    /** Stored verbatim from the `Last-Modified` response header and echoed on the next fetch. */
    lastModified: text('last_modified'),
    /** When the collector last attempted this feed, success or failure. */
    lastFetchedAt: timestamp('last_fetched_at', { withTimezone: true }),
    /** Message from the most recent failed attempt; cleared on the next success. */
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('sources_feed_url_unique').on(table.feedUrl),
    // Partial index: the collector only ever queries sources it should fetch.
    index('sources_active_idx').on(table.isActive).where(sql`${table.isActive} = true`),
  ],
)

export type Source = typeof sources.$inferSelect
export type NewSource = typeof sources.$inferInsert
