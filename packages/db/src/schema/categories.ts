import { integer, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { z } from 'zod'

/**
 * A category's slug must be URL-safe: lowercase kebab-case, no leading,
 * trailing or repeated hyphens. Enforced here rather than only by the
 * database's unique index, so a bad value is rejected before it reaches SQL.
 */
export const categorySlugSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'must be lowercase kebab-case (e.g. "world-news")')

/**
 * Curated, operator-managed groupings that articles will later be filed
 * under (see Issue #8) — not user-generated tags. There is no API to create
 * one yet, only the seed script in this package; linking articles to a
 * category is a separate, later change.
 */
export const categories = pgTable(
  'categories',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    displayOrder: integer('display_order').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('categories_slug_unique').on(table.slug)],
)

export type Category = typeof categories.$inferSelect
export type NewCategory = typeof categories.$inferInsert
