import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { type ApiClient, SystemStatusSchema } from '@newsdeck/api-contract'
import { createLocalAuthProvider } from '@newsdeck/auth'
import { createDatabase, type DatabaseHandle, runMigrations } from '@newsdeck/db'
import {
  createRedisConnection,
  createSystemQueue,
  type JobQueue,
  publishWorkerHeartbeat,
  type RedisConnection,
} from '@newsdeck/jobs'
import { REQUEST_ID_HEADER } from '@newsdeck/logger'
import { createORPCClient } from '@orpc/client'
import { RPCLink } from '@orpc/client/fetch'
import { createSystemRepository } from '../src/modules/system/repository.ts'
import { createSystemService } from '../src/modules/system/service.ts'
import { buildServer } from '../src/server.ts'
import { silentLogger } from './support/fakes.ts'

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL
const TEST_REDIS_URL = process.env.TEST_REDIS_URL
const canRun = Boolean(TEST_DATABASE_URL) && Boolean(TEST_REDIS_URL)

/**
 * Exercises the full server-side chain with real infrastructure:
 *
 *   oRPC client -> RPCLink -> Elysia -> oRPC handler -> service -> repository
 *   -> PostgreSQL, plus Redis for queue depth and worker liveness.
 *
 * The link's `fetch` is pointed straight at the Elysia app rather than a
 * socket, so the test covers the wire protocol without needing a listener.
 */
describe.skipIf(!canRun)('oRPC over the real stack', () => {
  let database: DatabaseHandle
  let redis: RedisConnection
  let queue: JobQueue
  let client: ApiClient
  let capturedRequestIds: string[]

  beforeAll(async () => {
    database = createDatabase({ url: TEST_DATABASE_URL as string, maxConnections: 2 })
    await runMigrations(database)

    redis = createRedisConnection({ url: TEST_REDIS_URL as string, clientName: 'api-itest' })
    queue = createSystemQueue(redis)

    const server = buildServer({
      logger: silentLogger(),
      instanceId: 'api-itest',
      authProvider: createLocalAuthProvider({
        signingKey: 'local-development-signing-key',
        issuer: 'newsdeck-local',
        audience: 'newsdeck',
      }),
      corsOrigins: [],
      startedAt: Date.now() - 5_000,
      services: {
        system: createSystemService({
          repository: createSystemRepository(database),
          redis,
          queue,
          instanceId: 'api-itest',
          startedAt: Date.now() - 5_000,
        }),
      },
    })

    capturedRequestIds = []
    const link = new RPCLink({
      url: 'http://api.test/rpc',
      fetch: async (request) => {
        const id = request.headers.get(REQUEST_ID_HEADER)
        if (id !== null) capturedRequestIds.push(id)
        return server.handle(request)
      },
      headers: () => ({ [REQUEST_ID_HEADER]: 'req-integration-abc' }),
    })
    client = createORPCClient(link)
  })

  afterAll(async () => {
    await queue?.close()
    redis?.disconnect()
    await database?.close()
  })

  it('returns a payload that satisfies the published contract', async () => {
    const status = await client.system.status()

    expect(() => SystemStatusSchema.parse(status)).not.toThrow()
  })

  it('reports both infrastructure dependencies as healthy', async () => {
    const status = await client.system.status()

    expect(status.checks.database.ok).toBe(true)
    expect(status.checks.redis.ok).toBe(true)
  })

  it('identifies the replica that served the call', async () => {
    const status = await client.system.status()

    expect(status.instanceId).toBe('api-itest')
    expect(status.service).toBe('api')
  })

  it('propagates the caller-supplied correlation id into the response body', async () => {
    const status = await client.system.status()

    expect(capturedRequestIds).toContain('req-integration-abc')
    expect(status.requestId).toBe('req-integration-abc')
  })

  it('reports queue depth read from the live queue', async () => {
    const status = await client.system.status()

    expect(status.queue.name).toBe('system')
    expect(status.queue.waiting).toBeGreaterThanOrEqual(0)
  })

  it('surfaces a worker heartbeat once one has been published', async () => {
    await publishWorkerHeartbeat(redis, 'worker-itest')

    const status = await client.system.status()

    expect(status.worker?.instanceId).toBe('worker-itest')
    expect(status.worker?.ageSeconds).toBeLessThan(10)
  })
})
