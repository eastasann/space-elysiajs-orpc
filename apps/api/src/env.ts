import { authEnvSchema } from '@newsdeck/auth'
import { integerFromEnv, stringList } from '@newsdeck/config'
import { databaseEnvSchema } from '@newsdeck/db'
import { redisEnvSchema } from '@newsdeck/jobs'
import { z } from 'zod'

export const apiEnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
    API_PORT: integerFromEnv({ default: 3001, min: 1, max: 65535 }),
    /**
     * Identifies this replica in logs and in `system.status`. Compose assigns
     * `api-1` / `api-2`; anywhere else it falls back to the hostname, which in
     * a container is the container id.
     */
    INSTANCE_ID: z.string().min(1).optional(),
    /**
     * Browser origins allowed to call the API directly. Needed only when a
     * client is NOT served through the reverse proxy — chiefly the host-mode
     * dev workflow, where web runs on :3000 and the API on :3001.
     */
    API_CORS_ORIGINS: stringList([]),
  })
  .extend(databaseEnvSchema.shape)
  .extend(redisEnvSchema.shape)
  .extend(authEnvSchema.shape)

export type ApiEnv = z.infer<typeof apiEnvSchema>
