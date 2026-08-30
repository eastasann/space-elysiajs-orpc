import { Worker } from 'bullmq'
import { SYSTEM_QUEUE_NAME } from './definitions.ts'
import { DEFAULT_JOBS_NAMESPACE } from './namespace.ts'
import type { JobWorker, QueuedJob, RedisConnection } from './types.ts'

export interface SystemWorkerOptions {
  /**
   * A dedicated connection. BullMQ's consumer blocks, so it must not be shared
   * with a producer — queue writes would stall behind a blocking read.
   */
  connection: RedisConnection
  processor(job: QueuedJob): Promise<void>
  concurrency: number
  namespace?: string
}

/**
 * Start consuming the system queue.
 *
 * Constructing the BullMQ worker here, rather than in the worker application,
 * keeps every reference to the queue implementation inside this package — the
 * boundary `docs/architecture.md#packages` describes.
 */
export function createSystemWorker(options: SystemWorkerOptions): JobWorker {
  return new Worker(SYSTEM_QUEUE_NAME, options.processor, {
    connection: options.connection,
    concurrency: options.concurrency,
    prefix: options.namespace ?? DEFAULT_JOBS_NAMESPACE,
  })
}
