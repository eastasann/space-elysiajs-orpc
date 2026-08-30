import { Queue } from 'bullmq'
import { SYSTEM_QUEUE_NAME } from './definitions.ts'
import type { JobQueue, RedisConnection } from './types.ts'

export interface QueueDepthSnapshot {
  name: string
  waiting: number
  active: number
  completed: number
  failed: number
  delayed: number
}

/**
 * Open the system queue.
 *
 * The API holds one to observe depth and to enqueue work; the worker holds one
 * to register repeatable jobs. Both share a Redis connection owned by the
 * caller, so shutdown ordering stays explicit.
 */
export function createSystemQueue(connection: RedisConnection): JobQueue {
  return new Queue(SYSTEM_QUEUE_NAME, { connection })
}

/** Read job counts for the admin collector view and `system.status`. */
export async function readQueueDepth(queue: JobQueue): Promise<QueueDepthSnapshot> {
  const counts = await queue.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed')

  return {
    name: queue.name,
    waiting: counts.waiting ?? 0,
    active: counts.active ?? 0,
    completed: counts.completed ?? 0,
    failed: counts.failed ?? 0,
    delayed: counts.delayed ?? 0,
  }
}
