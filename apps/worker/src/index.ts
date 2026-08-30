/**
 * Worker process entry point.
 *
 * Runs separately from the API so that slow or failing background work can
 * never consume the capacity that serves user requests, and so the two can be
 * scaled and restarted independently.
 */
import { hostname } from 'node:os'
import { parseEnv } from '@newsdeck/config'
import {
  createRedisConnection,
  createSystemQueue,
  heartbeatJob,
  SYSTEM_QUEUE_NAME,
} from '@newsdeck/jobs'
import { createLogger } from '@newsdeck/logger'
import { Worker } from 'bullmq'
import { workerEnvSchema } from './env.ts'
import { createHeartbeatHandler } from './handlers/heartbeat.ts'
import { createHandlerRegistry } from './handlers/registry.ts'
import { startHealthServer } from './health.ts'
import { createProcessor } from './processor.ts'

const startedAt = Date.now()
const env = parseEnv(workerEnvSchema, process.env)
const instanceId = env.INSTANCE_ID ?? hostname()

const logger = createLogger({ service: 'worker', instanceId, level: env.LOG_LEVEL })

// BullMQ needs a dedicated blocking connection for the consumer; sharing one
// with the producer would stall queue writes behind a blocking read.
const consumerRedis = createRedisConnection({
  url: env.REDIS_URL,
  clientName: `worker:${instanceId}`,
})
const producerRedis = createRedisConnection({
  url: env.REDIS_URL,
  clientName: `worker-producer:${instanceId}`,
})
for (const [name, connection] of [
  ['consumer', consumerRedis],
  ['producer', producerRedis],
] as const) {
  connection.on('error', (error: Error) =>
    logger.error({ err: error, name }, 'redis connection error'),
  )
}

const queue = createSystemQueue(producerRedis)

const registry = createHandlerRegistry([createHeartbeatHandler(producerRedis)])

const worker = new Worker(SYSTEM_QUEUE_NAME, createProcessor({ registry, logger, instanceId }), {
  connection: consumerRedis,
  concurrency: env.WORKER_CONCURRENCY,
})

worker.on('failed', (job, error) => {
  logger.error({ err: error, jobId: job?.id, jobName: job?.name }, 'job failed')
})
worker.on('error', (error) => logger.error({ err: error }, 'worker error'))

/**
 * Register the repeating heartbeat.
 *
 * `upsertJobScheduler` is idempotent and keyed, so every worker replica can run
 * this at start-up without producing duplicate schedules.
 */
await queue.upsertJobScheduler(
  'system-heartbeat',
  { every: env.WORKER_HEARTBEAT_INTERVAL_SECONDS * 1000 },
  { name: heartbeatJob.name, data: {} },
)

const health = startHealthServer({ port: env.WORKER_PORT, instanceId, startedAt })

logger.info(
  {
    queue: SYSTEM_QUEUE_NAME,
    concurrency: env.WORKER_CONCURRENCY,
    heartbeatIntervalSeconds: env.WORKER_HEARTBEAT_INTERVAL_SECONDS,
    healthPort: env.WORKER_PORT,
  },
  'worker started',
)

let shuttingDown = false

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  logger.info({ signal }, 'shutting down')

  // Close the worker first so in-flight jobs finish before connections drop.
  await worker.close()
  await queue.close()
  health.stop(true)
  consumerRedis.disconnect()
  producerRedis.disconnect()

  logger.info('shutdown complete')
  process.exit(0)
}

process.on('SIGTERM', (signal) => void shutdown(signal))
process.on('SIGINT', (signal) => void shutdown(signal))
