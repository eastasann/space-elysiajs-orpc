/**
 * API process entry point.
 *
 * Responsibilities, in order: read and validate configuration, open
 * infrastructure connections, construct services, expose HTTP, and shut all of
 * it down cleanly. No business logic lives here.
 */
import { hostname } from 'node:os'
import { createAuthProvider } from '@newsdeck/auth'
import { parseEnv } from '@newsdeck/config'
import { createDatabase } from '@newsdeck/db'
import { createRedisConnection, createSystemQueue } from '@newsdeck/jobs'
import { createLogger } from '@newsdeck/logger'
import { apiEnvSchema } from './env.ts'
import { createSourcesRepository } from './modules/sources/repository.ts'
import { createSourcesService } from './modules/sources/service.ts'
import { createSystemRepository } from './modules/system/repository.ts'
import { createSystemService } from './modules/system/service.ts'
import { buildServer } from './server.ts'

const startedAt = Date.now()
const env = parseEnv(apiEnvSchema, process.env)
const instanceId = env.INSTANCE_ID ?? hostname()

const logger = createLogger({ service: 'api', instanceId, level: env.LOG_LEVEL })

const database = createDatabase({
  url: env.DATABASE_URL,
  maxConnections: env.DATABASE_MAX_CONNECTIONS,
})
const redis = createRedisConnection({ url: env.REDIS_URL, clientName: `api:${instanceId}` })
redis.on('error', (error: Error) => logger.error({ err: error }, 'redis connection error'))

const queue = createSystemQueue(redis)

const server = buildServer({
  logger,
  instanceId,
  authProvider: createAuthProvider(env),
  corsOrigins: env.API_CORS_ORIGINS,
  startedAt,
  services: {
    system: createSystemService({
      repository: createSystemRepository(database),
      redis,
      queue,
      instanceId,
      startedAt,
    }),
    sources: createSourcesService(createSourcesRepository(database)),
  },
})

server.listen({ port: env.API_PORT, hostname: '0.0.0.0' })
logger.info({ port: env.API_PORT, authProvider: env.AUTH_PROVIDER }, 'api listening')

let shuttingDown = false

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  logger.info({ signal }, 'shutting down')

  // Stop accepting connections first, then release infrastructure, so in-flight
  // requests are not cut off mid-query during a rolling restart.
  await server.stop()
  await queue.close()
  redis.disconnect()
  await database.close()

  logger.info('shutdown complete')
  process.exit(0)
}

process.on('SIGTERM', (signal) => void shutdown(signal))
process.on('SIGINT', (signal) => void shutdown(signal))
