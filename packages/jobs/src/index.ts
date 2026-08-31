/**
 * Background processing boundary.
 *
 * Shared by the API (which enqueues and observes) and the worker (which
 * consumes). Server-only: it opens sockets and must never reach a browser or
 * React Native bundle.
 *
 * Every reference to the underlying queue implementation lives here.
 * Applications depend on the aliases in `types.ts`, never on `bullmq` or
 * `ioredis` directly.
 */

export {
  createRedisConnection,
  probeRedis,
  type RedisConnectionOptions,
  type RedisProbeResult,
} from './connection.ts'
export {
  type HeartbeatPayload,
  heartbeatJob,
  type JobDefinition,
  SOURCES_FETCH_JOB_OPTIONS,
  type SourcesFetchPayload,
  SYSTEM_QUEUE_NAME,
  sourcesFetchJob,
} from './definitions.ts'
export { type RedisEnv, redisEnvSchema, type WorkerQueueEnv, workerQueueEnvSchema } from './env.ts'
export { UnrecoverableError } from './errors.ts'
export {
  publishWorkerHeartbeat,
  readWorkerHeartbeat,
  type WorkerHeartbeatRecord,
} from './heartbeat.ts'
export { DEFAULT_JOBS_NAMESPACE } from './namespace.ts'
export { createSystemQueue, type QueueDepthSnapshot, readQueueDepth } from './queue.ts'
export type { JobQueue, JobWorker, QueuedJob, RedisConnection } from './types.ts'
export { createSystemWorker, type SystemWorkerOptions } from './worker.ts'
