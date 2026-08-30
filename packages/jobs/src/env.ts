import { integerFromEnv } from '@newsdeck/config'
import { z } from 'zod'

export const redisEnvSchema = z.object({
  REDIS_URL: z.string().min(1, 'is required'),
})

export const workerQueueEnvSchema = redisEnvSchema.extend({
  WORKER_CONCURRENCY: integerFromEnv({ default: 4, min: 1, max: 64 }),
  /** Interval between heartbeat jobs, in seconds. */
  WORKER_HEARTBEAT_INTERVAL_SECONDS: integerFromEnv({ default: 10, min: 1, max: 3600 }),
})

export type RedisEnv = z.infer<typeof redisEnvSchema>
export type WorkerQueueEnv = z.infer<typeof workerQueueEnvSchema>
