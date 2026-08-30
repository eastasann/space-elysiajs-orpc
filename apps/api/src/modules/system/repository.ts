import type { DependencyCheck } from '@newsdeck/api-contract'
import type { DatabaseHandle } from '@newsdeck/db'
import { probeDatabase } from '@newsdeck/db'

/**
 * Persistence access for the system module.
 *
 * Deliberately thin: the only durable state the status endpoint reads today is
 * "can we reach PostgreSQL". It exists as a separate file because it is the
 * layer every future module copies — SQL and Drizzle imports live here, and
 * nowhere above.
 */
export interface SystemRepository {
  probe(): Promise<DependencyCheck>
}

export function createSystemRepository(handle: DatabaseHandle): SystemRepository {
  return {
    async probe() {
      const result = await probeDatabase(handle)
      return result.detail === undefined
        ? { ok: result.ok, latencyMs: result.latencyMs }
        : { ok: result.ok, latencyMs: result.latencyMs, detail: result.detail }
    },
  }
}
