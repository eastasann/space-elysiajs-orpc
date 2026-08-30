import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema/index.ts'

export interface DatabaseOptions {
  url: string
  /** Pool size per process. Behind a load balancer this is per API replica. */
  maxConnections?: number
  /** Seconds an idle pooled connection is kept before being closed. */
  idleTimeoutSeconds?: number
  connectTimeoutSeconds?: number
}

export interface DatabaseHandle {
  db: Database
  /** Escape hatch for health probes and migrations. Prefer `db` elsewhere. */
  sql: postgres.Sql
  close(): Promise<void>
}

export type Database = ReturnType<typeof drizzle<typeof schema>>

/**
 * Open a connection pool.
 *
 * Callers own the handle's lifetime and must `close()` it on shutdown so that
 * rolling restarts do not leave connections pinned on the database.
 */
export function createDatabase(options: DatabaseOptions): DatabaseHandle {
  const sql = postgres(options.url, {
    max: options.maxConnections ?? 10,
    idle_timeout: options.idleTimeoutSeconds ?? 30,
    connect_timeout: options.connectTimeoutSeconds ?? 10,
    onnotice: () => {},
  })

  return {
    db: drizzle(sql, { schema }),
    sql,
    close: async () => {
      await sql.end({ timeout: 5 })
    },
  }
}
