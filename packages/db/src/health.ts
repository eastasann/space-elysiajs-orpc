import type { DatabaseHandle } from './client.ts'

export interface DatabaseProbeResult {
  ok: boolean
  latencyMs: number
  detail?: string
}

/**
 * Probe the database with a trivial round trip.
 *
 * Failures are reported as a short message rather than a thrown error so that
 * a status endpoint can stay available while a dependency is down. The message
 * is taken from the error only — connection strings hold credentials and must
 * never reach a response body.
 */
export async function probeDatabase(
  handle: DatabaseHandle,
  timeoutMs = 2000,
): Promise<DatabaseProbeResult> {
  const startedAt = performance.now()

  try {
    await Promise.race([
      handle.sql`select 1`,
      new Promise((_resolve, reject) => {
        setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs)
      }),
    ])
    return { ok: true, latencyMs: Math.round(performance.now() - startedAt) }
  } catch (error) {
    return {
      ok: false,
      latencyMs: Math.round(performance.now() - startedAt),
      detail: error instanceof Error ? error.message : 'unknown database error',
    }
  }
}
