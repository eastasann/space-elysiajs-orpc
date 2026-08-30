/**
 * Background processing boundary.
 *
 * Shared by the API (which enqueues and observes) and the worker (which
 * consumes). Server-only: it opens sockets and must never reach a browser or
 * React Native bundle.
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
  SYSTEM_QUEUE_NAME,
} from './definitions.ts'
export { type RedisEnv, redisEnvSchema, type WorkerQueueEnv, workerQueueEnvSchema } from './env.ts'
export {
  publishWorkerHeartbeat,
  readWorkerHeartbeat,
  type WorkerHeartbeatRecord,
} from './heartbeat.ts'
export { createSystemQueue, type QueueDepthSnapshot, readQueueDepth } from './queue.ts'
export type { JobQueue, RedisConnection } from './types.ts'
