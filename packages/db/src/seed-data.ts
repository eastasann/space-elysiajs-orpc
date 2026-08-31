import type { NewCategory } from './schema/categories.ts'

/**
 * The initial, curated set of categories. Operators change this list over
 * time; `bun run db:seed` is what applies an edit, not a migration — see
 * AGENTS.md §4 on migrations describing schema, not data.
 */
export const initialCategories: Omit<NewCategory, 'id' | 'createdAt' | 'updatedAt'>[] = [
  { slug: 'world', name: 'World', displayOrder: 0 },
  { slug: 'business', name: 'Business', displayOrder: 1 },
  { slug: 'technology', name: 'Technology', displayOrder: 2 },
  { slug: 'science', name: 'Science', displayOrder: 3 },
  { slug: 'health', name: 'Health', displayOrder: 4 },
  { slug: 'sports', name: 'Sports', displayOrder: 5 },
  { slug: 'entertainment', name: 'Entertainment', displayOrder: 6 },
]
