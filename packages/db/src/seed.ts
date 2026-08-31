/**
 * Entry point for `bun run db:seed`.
 *
 * Loads the curated, operator-managed category list. Categories are not a
 * migration concern — a migration describes schema, and this list changes far
 * more often than the table does (AGENTS.md §4) — so it lives here instead,
 * as an upsert keyed on `slug`. Running it any number of times converges on
 * the same rows rather than duplicating them.
 */
import { parseEnv } from '@newsdeck/config'
import { createDatabase } from './client.ts'
import { databaseEnvSchema } from './env.ts'
import { seedCategories } from './seed-categories.ts'

const env = parseEnv(databaseEnvSchema, process.env)
const handle = createDatabase({ url: env.DATABASE_URL, maxConnections: 1 })

try {
  const count = await seedCategories(handle.db)
  process.stdout.write(`seeded ${count} categories\n`)
} catch (error) {
  process.stderr.write(`seed failed: ${error instanceof Error ? error.message : error}\n`)
  process.exitCode = 1
} finally {
  await handle.close()
}
