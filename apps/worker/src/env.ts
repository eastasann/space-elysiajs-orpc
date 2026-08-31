import { integerFromEnv } from '@newsdeck/config'
import { databaseEnvSchema } from '@newsdeck/db'
import { workerQueueEnvSchema } from '@newsdeck/jobs'
import { z } from 'zod'

/**
 * `sources.fetch` is the first handler that persists anything, so this is the
 * first version of the worker that requires `DATABASE_URL`.
 */
export const workerEnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
    /** Port for the liveness endpoint the container health check calls. */
    WORKER_PORT: integerFromEnv({ default: 3002, min: 1, max: 65535 }),
    INSTANCE_ID: z.string().min(1).optional(),
  })
  .extend(workerQueueEnvSchema.shape)
  .extend(databaseEnvSchema.shape)

export type WorkerEnv = z.infer<typeof workerEnvSchema>
