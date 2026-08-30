import { migrate } from 'drizzle-orm/postgres-js/migrator'
import type { DatabaseHandle } from './client.ts'

/** Absolute path to the generated SQL migrations shipped with this package. */
const MIGRATIONS_FOLDER = new URL('../drizzle', import.meta.url).pathname

/**
 * Apply every pending migration.
 *
 * Drizzle takes a Postgres advisory lock for the duration, so running this
 * concurrently from several replicas is safe: one applies, the others wait and
 * then observe an up-to-date schema.
 */
export async function runMigrations(handle: DatabaseHandle): Promise<void> {
  await migrate(handle.db, { migrationsFolder: MIGRATIONS_FOLDER })
}
