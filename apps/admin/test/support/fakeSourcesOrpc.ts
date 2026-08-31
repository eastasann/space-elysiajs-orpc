import { createTanstackQueryUtils } from '@newsdeck/api-client'
import type { ApiClient, Source } from '@newsdeck/api-contract'

export function fakeSource(overrides: Partial<Source> = {}): Source {
  return {
    id: 'source-1',
    name: 'Example feed',
    feedUrl: 'https://example.test/feed.xml',
    siteUrl: null,
    isActive: true,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  }
}

export interface FakeSourcesClientOptions {
  list?: ApiClient['sources']['list']
  get?: ApiClient['sources']['get']
  create?: ApiClient['sources']['create']
  update?: ApiClient['sources']['update']
  deactivate?: ApiClient['sources']['deactivate']
}

/**
 * Builds the same TanStack Query bindings the app gets from `createApiClient`
 * (`orpc.sources`), wired to a fake client instead of a real transport. Tests
 * exercise the real `queryOptions`/`mutationOptions` wiring, not a
 * hand-rolled stand-in for it.
 */
export function fakeSourcesOrpc(options: FakeSourcesClientOptions = {}) {
  const defaultSource = fakeSource()
  const client: ApiClient['sources'] = {
    list: options.list ?? (async () => ({ items: [], total: 0 })),
    get: options.get ?? (async () => null),
    create: options.create ?? (async () => defaultSource),
    update: options.update ?? (async () => defaultSource),
    deactivate: options.deactivate ?? (async () => defaultSource),
  }

  return createTanstackQueryUtils({ sources: client }).sources
}
