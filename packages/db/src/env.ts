import { integerFromEnv } from '@newsdeck/config'
import { z } from 'zod'

/** Environment every process that opens a database pool must satisfy. */
export const databaseEnvSchema = z.object({
  DATABASE_URL: z.string().min(1, 'is required'),
  DATABASE_MAX_CONNECTIONS: integerFromEnv({ default: 10, min: 1, max: 100 }),
})

export type DatabaseEnv = z.infer<typeof databaseEnvSchema>
