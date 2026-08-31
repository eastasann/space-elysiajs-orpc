import { index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { categories } from './categories.ts'
import { sources } from './sources.ts'

/**
 * An article collected from a source's feed.
 *
 * `fetchedAt` — not `publishedAt` — drives "most recent" ordering. A feed's
 * `publishedAt` is supplied by the source and may be missing, backdated or
 * outright wrong; `fetchedAt` is set by the collector and always present, so
 * it is the only timestamp every list can sort by consistently.
 *
 * Deleting a source restricts rather than cascades: a source's articles are
 * the record of what it published, and removing the source must not silently
 * erase that history. A category may be removed freely — its articles simply
 * become uncategorised.
 */
export const articles = pgTable(
  'articles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sourceId: uuid('source_id')
      .notNull()
      .references(() => sources.id, { onDelete: 'restrict' }),
    categoryId: uuid('category_id').references(() => categories.id, { onDelete: 'set null' }),
    url: text('url').notNull(),
    canonicalUrl: text('canonical_url').notNull(),
    title: text('title').notNull(),
    summary: text('summary'),
    author: text('author'),
    imageUrl: text('image_url'),
    /** Hash of the article's content, for duplicate detection across URLs. */
    contentHash: text('content_hash').notNull(),
    /** As reported by the feed. May be absent or unreliable — see above. */
    publishedAt: timestamp('published_at', { withTimezone: true }),
    /** When the collector fetched this article. Always known. */
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('articles_canonical_url_unique').on(table.canonicalUrl),
    index('articles_fetched_at_idx').on(table.fetchedAt.desc()),
    index('articles_category_fetched_at_idx').on(table.categoryId, table.fetchedAt.desc()),
  ],
)

export type Article = typeof articles.$inferSelect
export type NewArticle = typeof articles.$inferInsert
