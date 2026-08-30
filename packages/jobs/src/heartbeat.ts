import type { RedisConnection } from './types.ts'

const HEARTBEAT_KEY = 'newsdeck:worker:heartbeat'

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
): Promise<void> {
  const payload = JSON.stringify({ instanceId, observedAt: new Date().toISOString() })
  await redis.set(HEARTBEAT_KEY, payload, 'EX', HEARTBEAT_TTL_SECONDS)
}

/**
 * Read the most recent worker heartbeat.
 *
 * Returns `null` when no worker has reported inside the TTL — which is exactly
 * what a stopped or wedged worker looks like from the API's point of view.
 */
export async function readWorkerHeartbeat(
  redis: RedisConnection,
): Promise<WorkerHeartbeatRecord | null> {
  const raw = await redis.get(HEARTBEAT_KEY)
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
