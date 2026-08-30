import type { ApiClient } from '@newsdeck/api-client'
import type { SystemStatus } from '@newsdeck/api-contract'

export function fakeStatus(instanceId: string): SystemStatus {
  return {
    service: 'api',
    instanceId,
    requestId: 'req-test',
    uptimeSeconds: 12,
    checks: {
      database: { ok: true, latencyMs: 1 },
      redis: { ok: true, latencyMs: 1 },
    },
    queue: { name: 'system', waiting: 0, active: 0, completed: 3, failed: 0, delayed: 0 },
    worker: null,
  }
}

/**
 * A `system.status` that answers deterministically from a fixed script,
 * cycling once it runs out. An entry of `null` fails the call, mirroring a
 * replica that could not be reached.
 */
export function fakeApiClient(script: readonly (string | null)[]): Pick<ApiClient, 'system'> {
  let calls = 0

  return {
    system: {
      status: async () => {
        const outcome = script[calls % script.length]
        calls += 1
        if (outcome === null || outcome === undefined) {
          throw new Error('simulated network failure')
        }
        return fakeStatus(outcome)
      },
    },
  }
}
