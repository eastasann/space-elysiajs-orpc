import { sql } from 'drizzle-orm'
import { boolean, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'

/**
 * A feed the collector reads from.
 *
 * Only the identity of a feed lives here. Fetch bookkeeping (`last_fetched_at`,
 * `etag`, `last_error`) belongs with the job that writes it, not with the
 * table that names the feed.
 */
export const sources = pgTable(
  'sources',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    feedUrl: text('feed_url').notNull(),
    siteUrl: text('site_url'),
    isActive: boolean('is_active').notNull().default(true),
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
