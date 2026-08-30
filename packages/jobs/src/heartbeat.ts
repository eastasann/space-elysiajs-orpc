import { DEFAULT_JOBS_NAMESPACE } from './namespace.ts'
import type { RedisConnection } from './types.ts'

function heartbeatKey(namespace: string): string {
  return `${namespace}:worker:heartbeat`
}

/**
 * How long a published heartbeat stays readable. Comfortably longer than the
 * publish interval so a single missed run does not read as a dead worker.
 */
const HEARTBEAT_TTL_SECONDS = 90

export interface WorkerHeartbeatRecord {
  instanceId: string
  observedAt: string
  ageSeconds: number
}

/** Publish worker liveness. Called by the worker's heartbeat job handler. */
export async function publishWorkerHeartbeat(
  redis: RedisConnection,
  instanceId: string,
  namespace: string = DEFAULT_JOBS_NAMESPACE,
): Promise<void> {
  const payload = JSON.stringify({ instanceId, observedAt: new Date().toISOString() })
  await redis.set(heartbeatKey(namespace), payload, 'EX', HEARTBEAT_TTL_SECONDS)
}

/**
 * Read the most recent worker heartbeat.
 *
 * Returns `null` when no worker has reported inside the TTL — which is exactly
 * what a stopped or wedged worker looks like from the API's point of view.
 *
 * `namespace` must match the one the worker publishes under, or every read
 * looks like a dead worker.
 */
export async function readWorkerHeartbeat(
  redis: RedisConnection,
  namespace: string = DEFAULT_JOBS_NAMESPACE,
): Promise<WorkerHeartbeatRecord | null> {
  const raw = await redis.get(heartbeatKey(namespace))
  if (raw === null) return null

  try {
    const parsed = JSON.parse(raw) as { instanceId?: unknown; observedAt?: unknown }
    if (typeof parsed.instanceId !== 'string' || typeof parsed.observedAt !== 'string') return null

    const observedAtMs = Date.parse(parsed.observedAt)
    if (Number.isNaN(observedAtMs)) return null

    return {
      instanceId: parsed.instanceId,
      observedAt: parsed.observedAt,
      ageSeconds: Math.max(0, Math.round((Date.now() - observedAtMs) / 1000)),
    }
  } catch {
    return null
  }
}
