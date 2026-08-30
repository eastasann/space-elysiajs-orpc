import { integerFromEnv } from '@newsdeck/config'
import { workerQueueEnvSchema } from '@newsdeck/jobs'
import { z } from 'zod'

/**
 * The worker deliberately does NOT require `DATABASE_URL`: it performs no
 * persistence yet. News ingestion adds it together with the code that uses it,
 * so configuration never claims a dependency the process does not have.
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

export type WorkerEnv = z.infer<typeof workerEnvSchema>
