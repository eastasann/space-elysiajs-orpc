import {
  type HeartbeatPayload,
  heartbeatJob,
  publishWorkerHeartbeat,
  type RedisConnection,
} from '@newsdeck/jobs'
import type { JobHandler } from './registry.ts'

/**
 * Publishes worker liveness to Redis.
 *
 * This is the bootstrap's proof that the queue round trip works: the worker
 * schedules it, consumes it, and the API reports the result through
 * `system.status`. News ingestion handlers will follow the same shape.
 */
export function createHeartbeatHandler(
  redis: RedisConnection,
  namespace?: string,
): JobHandler<HeartbeatPayload> {
  return {
    definition: heartbeatJob,
    async process(payload, context) {
      await publishWorkerHeartbeat(redis, context.instanceId, namespace)
      context.logger.debug({ requestId: payload.requestId }, 'heartbeat published')
    },
  }
}
