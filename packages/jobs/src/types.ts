import type { Queue } from 'bullmq'
import type { Redis } from 'ioredis'

/**
 * Structural aliases for the queue and cache clients.
 *
 * Applications depend on these rather than on `bullmq` / `ioredis` directly, so
 * that swapping the queue implementation stays a change inside this package.
 */
export type JobQueue = Queue
export type RedisConnection = Redis
