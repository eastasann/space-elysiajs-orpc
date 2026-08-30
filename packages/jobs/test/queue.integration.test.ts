import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import type { Queue } from 'bullmq'
import type { Redis } from 'ioredis'
import {
  createRedisConnection,
  createSystemQueue,
  heartbeatJob,
  probeRedis,
  publishWorkerHeartbeat,
  readQueueDepth,
  readWorkerHeartbeat,
} from '../src/index.ts'

const TEST_REDIS_URL = process.env.TEST_REDIS_URL

/**
 * Every Redis key this suite touches is namespaced to it.
 *
 * Without that, a worker running against the same Redis — the compose stack, or
 * the concurrently executing `@newsdeck/worker` suite — would consume these
 * jobs and overwrite this heartbeat, and the assertions below would be racing
 * something they cannot see.
 */
const NAMESPACE = 'newsdeck-test-jobs'

/**
 * Integration coverage for the queue boundary. Requires a Redis-compatible
 * service; see docs/development.md#testing.
 */
describe.skipIf(!TEST_REDIS_URL)('queue and heartbeat against a live Redis', () => {
  let redis: Redis
  let queue: Queue

  beforeAll(async () => {
    redis = createRedisConnection({ url: TEST_REDIS_URL as string, clientName: 'jobs-test' })
    queue = createSystemQueue(redis, NAMESPACE)
    await queue.obliterate({ force: true }).catch(() => {})
  })

  afterAll(async () => {
    await queue?.close()
    redis?.disconnect()
  })

  it('reports a healthy probe', async () => {
    const result = await probeRedis(redis)

    expect(result.ok).toBe(true)
    expect(result.latencyMs).toBeGreaterThanOrEqual(0)
  })

  it('counts an enqueued job as waiting', async () => {
    await queue.add(heartbeatJob.name, { requestId: 'req-integration-1' })

    const depth = await readQueueDepth(queue)

    expect(depth.name).toBe('system')
    expect(depth.waiting).toBeGreaterThanOrEqual(1)
  })

  it('returns null before any heartbeat is published', async () => {
    await redis.del(`${NAMESPACE}:worker:heartbeat`)

    expect(await readWorkerHeartbeat(redis, NAMESPACE)).toBeNull()
  })

  it('round-trips a published heartbeat', async () => {
    await publishWorkerHeartbeat(redis, 'worker-test-1', NAMESPACE)

    const heartbeat = await readWorkerHeartbeat(redis, NAMESPACE)

    expect(heartbeat?.instanceId).toBe('worker-test-1')
    expect(heartbeat?.ageSeconds).toBeLessThan(5)
    expect(Number.isNaN(Date.parse(heartbeat?.observedAt ?? ''))).toBe(false)
  })

  it('expires the heartbeat so a stopped worker stops looking alive', async () => {
    await publishWorkerHeartbeat(redis, 'worker-test-1', NAMESPACE)

    expect(await redis.ttl(`${NAMESPACE}:worker:heartbeat`)).toBeGreaterThan(0)
  })

  it('treats a corrupt heartbeat record as absent', async () => {
    await redis.set(`${NAMESPACE}:worker:heartbeat`, 'not json')

    expect(await readWorkerHeartbeat(redis, NAMESPACE)).toBeNull()
  })
})

describe('probeRedis', () => {
  it('reports failure without leaking the connection URL', async () => {
    const unreachable = createRedisConnection({
      url: 'redis://:hunter2@127.0.0.1:1',
      clientName: 'jobs-test-unreachable',
    })
    unreachable.on('error', () => {})

    const result = await probeRedis(unreachable, 300)

    expect(result.ok).toBe(false)
    expect(result.detail ?? '').not.toContain('hunter2')
    unreachable.disconnect()
  })
})

describe('job definitions', () => {
  it('validates heartbeat payloads', () => {
    expect(heartbeatJob.payloadSchema.safeParse({}).success).toBe(true)
    expect(heartbeatJob.payloadSchema.safeParse({ requestId: 'req-1' }).success).toBe(true)
    expect(heartbeatJob.payloadSchema.safeParse({ requestId: 42 }).success).toBe(false)
  })
})
