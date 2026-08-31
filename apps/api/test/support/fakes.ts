import type { SystemStatus } from '@newsdeck/api-contract'
import { createLogger, type Logger } from '@newsdeck/logger'
import type { AppServices } from '../../src/context.ts'
import { createSourcesService, type SourcesService } from '../../src/modules/sources/service.ts'
import type { SystemService } from '../../src/modules/system/service.ts'
import { fakeSourcesRepository } from './fake-sources-repository.ts'

export function silentLogger(): Logger {
  return createLogger({
    service: 'api-test',
    instanceId: 'api-test',
    level: 'silent',
    destination: { write: () => {} },
  })
}

export function fakeStatus(overrides: Partial<SystemStatus> = {}): SystemStatus {
  return {
    service: 'api',
    instanceId: 'api-test',
    requestId: 'req-placeholder',
    uptimeSeconds: 12,
    checks: {
      database: { ok: true, latencyMs: 1 },
      redis: { ok: true, latencyMs: 1 },
    },
    queue: { name: 'system', waiting: 0, active: 0, completed: 3, failed: 0, delayed: 0 },
    worker: { instanceId: 'worker-1', observedAt: new Date().toISOString(), ageSeconds: 2 },
    ...overrides,
  }
}

export interface FakeSystemService extends SystemService {
  /** Request ids `getStatus` was called with, in order. */
  readonly seenRequestIds: string[]
}

export function fakeSystemService(options: {
  status?: SystemStatus
  ready?: boolean
  failWith?: Error
}): FakeSystemService {
  const seenRequestIds: string[] = []

  return {
    seenRequestIds,
    async getStatus(requestId: string) {
      seenRequestIds.push(requestId)
      if (options.failWith !== undefined) throw options.failWith
      return { ...(options.status ?? fakeStatus()), requestId }
    },
    async isReady() {
      return options.ready ?? true
    },
  }
}

export function fakeServices(
  system: SystemService,
  sources: SourcesService = createSourcesService(fakeSourcesRepository()),
): AppServices {
  return { system, sources }
}
