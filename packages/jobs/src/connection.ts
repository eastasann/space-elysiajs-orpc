import { Redis } from 'ioredis'
import type { RedisConnection } from './types.ts'

export interface RedisConnectionOptions {
  url: string
  /** Distinguishes producer/consumer connections in `CLIENT LIST`. */
  clientName: string
}

/**
 * Open a Redis-compatible connection suitable for BullMQ.
 *
 * `maxRetriesPerRequest: null` is required by BullMQ: its blocking commands
 * must be allowed to wait indefinitely rather than be failed by the client.
 */
export function createRedisConnection(options: RedisConnectionOptions): RedisConnection {
  return new Redis(options.url, {
    connectionName: options.clientName,
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    lazyConnect: false,
  })
}

export interface RedisProbeResult {
  ok: boolean
  latencyMs: number
  detail?: string
}

/**
 * Probe the Redis-compatible service.
 *
 * Mirrors `probeDatabase`: reports rather than throws, and never echoes the
 * connection URL, which carries credentials in deployed environments.
 */
export async function probeRedis(
  redis: RedisConnection,
  timeoutMs = 2000,
): Promise<RedisProbeResult> {
  const startedAt = performance.now()

  try {
    const response = await Promise.race([
      redis.ping(),
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs)
      }),
    ])

    if (response !== 'PONG') {
      return {
        ok: false,
        latencyMs: Math.round(performance.now() - startedAt),
        detail: 'unexpected PING reply',
      }
    }
    return { ok: true, latencyMs: Math.round(performance.now() - startedAt) }
  } catch (error) {
    return {
      ok: false,
      latencyMs: Math.round(performance.now() - startedAt),
      detail: error instanceof Error ? error.message : 'unknown redis error',
    }
  }
}
