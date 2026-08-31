import { sql } from 'drizzle-orm'
import type { Database } from './client.ts'
import { categories, categorySlugSchema } from './schema/categories.ts'
import { initialCategories } from './seed-data.ts'

/**
 * Upsert the curated category list, keyed on `slug`. Safe to run any number
 * of times: an unchanged row is left alone, a changed one is updated in
 * place, and no run ever inserts a duplicate.
 */
export async function seedCategories(db: Database): Promise<number> {
  for (const category of initialCategories) {
    categorySlugSchema.parse(category.slug)
  }

  await db
    .insert(categories)
    .values(initialCategories)
    .onConflictDoUpdate({
      target: categories.slug,
      set: {
        name: sql`excluded.name`,
        displayOrder: sql`excluded.display_order`,
        updatedAt: new Date(),
      },
    })

  return initialCategories.length
}
