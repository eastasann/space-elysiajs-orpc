import type { SystemStatus } from '@newsdeck/api-contract'
import type { JobQueue, RedisConnection } from '@newsdeck/jobs'
import { probeRedis, readQueueDepth, readWorkerHeartbeat } from '@newsdeck/jobs'
import type { SystemRepository } from './repository.ts'

export interface SystemServiceDependencies {
  repository: SystemRepository
  redis: RedisConnection
  queue: JobQueue
  instanceId: string
  /** Process start time, used to derive uptime. */
  startedAt: number
  /**
   * Jobs namespace to observe. Must match the one the worker publishes under,
   * or the heartbeat below will always read as absent.
   */
  namespace?: string
}

export interface SystemService {
  getStatus(requestId: string): Promise<SystemStatus>
  /** Liveness for the readiness probe: true when every dependency answers. */
  isReady(): Promise<boolean>
}

/**
 * Application logic for platform status.
 *
 * Lives outside the transport layer so that the same behaviour is reachable
 * from oRPC today and from a CLI, a test, or another transport tomorrow.
 */
export function createSystemService(deps: SystemServiceDependencies): SystemService {
  async function collect(): Promise<Omit<SystemStatus, 'requestId'>> {
    // Probes are independent; running them concurrently keeps the status call
    // as slow as the slowest dependency rather than their sum.
    const [database, redis, queue, worker] = await Promise.all([
      deps.repository.probe(),
      probeRedis(deps.redis),
      readQueueDepth(deps.queue),
      readWorkerHeartbeat(deps.redis, deps.namespace),
    ])

    return {
      service: 'api',
      instanceId: deps.instanceId,
      uptimeSeconds: Math.round((Date.now() - deps.startedAt) / 1000),
      checks: {
        database,
        redis:
          redis.detail === undefined
            ? { ok: redis.ok, latencyMs: redis.latencyMs }
            : { ok: redis.ok, latencyMs: redis.latencyMs, detail: redis.detail },
      },
      queue,
      worker,
    }
  }

  return {
    async getStatus(requestId: string) {
      return { ...(await collect()), requestId }
    },

    async isReady() {
      const [database, redis] = await Promise.all([deps.repository.probe(), probeRedis(deps.redis)])
      return database.ok && redis.ok
    },
  }
}
