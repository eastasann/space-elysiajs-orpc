/**
 * Entry point for `bun run db:migrate`.
 *
 * Runs as a one-shot process: compose starts it before the API and worker so
 * that no application replica ever serves traffic against an older schema.
 */
import { parseEnv } from '@newsdeck/config'
import { createDatabase } from './client.ts'
import { databaseEnvSchema } from './env.ts'
import { runMigrations } from './migrator.ts'

const env = parseEnv(databaseEnvSchema, process.env)
const handle = createDatabase({ url: env.DATABASE_URL, maxConnections: 1 })

try {
  await runMigrations(handle)
  process.stdout.write('migrations applied\n')
} catch (error) {
  process.stderr.write(`migration failed: ${error instanceof Error ? error.message : error}\n`)
  process.exitCode = 1
} finally {
  await handle.close()
}
