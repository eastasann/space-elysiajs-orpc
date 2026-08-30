import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import {
  createRedisConnection,
  createSystemQueue,
  createSystemWorker,
  heartbeatJob,
  type JobQueue,
  type JobWorker,
  type RedisConnection,
  readWorkerHeartbeat,
} from '@newsdeck/jobs'
import { createLogger } from '@newsdeck/logger'
import { createHeartbeatHandler } from '../src/handlers/heartbeat.ts'
import { createHandlerRegistry } from '../src/handlers/registry.ts'
import { createProcessor } from '../src/processor.ts'

const TEST_REDIS_URL = process.env.TEST_REDIS_URL

/**
 * Namespaced so this suite owns its queue outright. Any other consumer on the
 * same Redis — the compose worker, or the concurrently executing
 * `@newsdeck/jobs` suite — would otherwise race it for these jobs.
 */
const NAMESPACE = 'newsdeck-test-worker'

function silentLogger() {
  return createLogger({
    service: 'worker-itest',
    instanceId: 'worker-itest',
    level: 'silent',
    destination: { write: () => {} },
  })
}

async function waitFor<T>(read: () => Promise<T | null>, timeoutMs = 10_000): Promise<T | null> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await read()
    if (value !== null) return value
    await Bun.sleep(100)
  }
  return null
}

/**
 * Proves the queue round trip the bootstrap depends on: a job enqueued on the
 * `system` queue is consumed by a real BullMQ worker, whose handler publishes
 * the heartbeat the API reports through `system.status`.
 */
describe.skipIf(!TEST_REDIS_URL)('worker consuming from a live queue', () => {
  let producerRedis: RedisConnection
  let consumerRedis: RedisConnection
  let queue: JobQueue
  let worker: JobWorker

  beforeAll(async () => {
    producerRedis = createRedisConnection({
      url: TEST_REDIS_URL as string,
      clientName: 'worker-itest-producer',
    })
    consumerRedis = createRedisConnection({
      url: TEST_REDIS_URL as string,
      clientName: 'worker-itest-consumer',
    })

    queue = createSystemQueue(producerRedis, NAMESPACE)
    await queue.obliterate({ force: true }).catch(() => {})
    await producerRedis.del(`${NAMESPACE}:worker:heartbeat`)

    worker = createSystemWorker({
      connection: consumerRedis,
      processor: createProcessor({
        registry: createHandlerRegistry([createHeartbeatHandler(producerRedis, NAMESPACE)]),
        logger: silentLogger(),
        instanceId: 'worker-itest',
      }),
      concurrency: 1,
      namespace: NAMESPACE,
    })
    await worker.waitUntilReady()
  })

  afterAll(async () => {
    await worker?.close()
    await queue?.close()
    producerRedis?.disconnect()
    consumerRedis?.disconnect()
  })

  it('consumes a heartbeat job and publishes worker liveness', async () => {
    await queue.add(heartbeatJob.name, { requestId: 'req-worker-itest1' })

    const heartbeat = await waitFor(() => readWorkerHeartbeat(producerRedis, NAMESPACE))

    expect(heartbeat?.instanceId).toBe('worker-itest')
    expect(heartbeat?.ageSeconds).toBeLessThan(15)
  })

  it('moves a job with no registered handler to the failed set', async () => {
    const job = await queue.add('news.doesNotExistYet', {})

    const state = await waitFor(async () => {
      const current = await job.getState()
      return current === 'failed' ? current : null
    })

    expect(state).toBe('failed')
    const counts = await queue.getJobCounts('failed')
    expect(counts.failed).toBeGreaterThanOrEqual(1)
  })

  it('moves a job with an invalid payload to the failed set', async () => {
    const job = await queue.add(heartbeatJob.name, { requestId: 12345 })

    const state = await waitFor(async () => {
      const current = await job.getState()
      return current === 'failed' ? current : null
    })

    expect(state).toBe('failed')
    // Re-read the job: the local handle is not refreshed when the worker fails it.
    const stored = await queue.getJob(job.id as string)
    expect(stored?.failedReason ?? '').toContain('Invalid payload')
  })
})
