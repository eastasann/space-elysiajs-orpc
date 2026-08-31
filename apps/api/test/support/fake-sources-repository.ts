import type { NewSource, Source } from '@newsdeck/db/schema'
import {
  DEFAULT_PAGE_SIZE,
  type ListSourcesOptions,
  type ListSourcesPage,
  MAX_PAGE_SIZE,
  type SourcesRepository,
  type UpdateSourceInput,
} from '../../src/modules/sources/repository.ts'

let sequence = 0

export function fakeSource(overrides: Partial<Source> = {}): Source {
  sequence += 1
  const now = new Date()
  return {
    id: `source-${sequence}`,
    name: 'Example Feed',
    feedUrl: `https://example.test/feed-${sequence}.xml`,
    siteUrl: null,
    isActive: true,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

/**
 * A raw driver error shaped the way postgres.js reports a unique violation,
 * wrapped the way Drizzle wraps it — see
 * `packages/db/test/migrations.integration.test.ts`. Lets a service test
 * exercise the race between a service's existence check and its write
 * without a real database.
 */
export function fakeUniqueViolation(constraintName: string): Error {
  const error = new Error('duplicate key value violates unique constraint') as Error & {
    cause: { code: string; constraint_name: string }
  }
  error.cause = { code: '23505', constraint_name: constraintName }
  return error
}

export interface FakeSourcesRepository extends SourcesRepository {
  readonly rows: Source[]
  /** Makes the next `insert` call throw this error instead of writing. */
  failNextInsertWith: Error | null
  /** Makes the next `update` call throw this error instead of writing. */
  failNextUpdateWith: Error | null
}

export function fakeSourcesRepository(seed: Source[] = []): FakeSourcesRepository {
  const repository: FakeSourcesRepository = {
    rows: [...seed],
    failNextInsertWith: null,
    failNextUpdateWith: null,

    async list(options: ListSourcesOptions = {}): Promise<ListSourcesPage> {
      const pageSize = Math.min(Math.max(options.pageSize ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE)
      const page = Math.max(options.page ?? 1, 1)
      const offset = (page - 1) * pageSize
      const sorted = [...repository.rows].sort(
        (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
      )

      return { items: sorted.slice(offset, offset + pageSize), total: repository.rows.length }
    },

    async findById(id: string): Promise<Source | null> {
      return repository.rows.find((row) => row.id === id) ?? null
    },

    async findByFeedUrl(feedUrl: string): Promise<Source | null> {
      return repository.rows.find((row) => row.feedUrl === feedUrl) ?? null
    },

    async insert(input: NewSource): Promise<Source> {
      if (repository.failNextInsertWith !== null) {
        const error = repository.failNextInsertWith
        repository.failNextInsertWith = null
        throw error
      }

      const row = fakeSource({
        name: input.name,
        feedUrl: input.feedUrl,
        siteUrl: input.siteUrl ?? null,
      })
      repository.rows.push(row)
      return row
    },

    async update(id: string, patch: UpdateSourceInput): Promise<Source | null> {
      if (repository.failNextUpdateWith !== null) {
        const error = repository.failNextUpdateWith
        repository.failNextUpdateWith = null
        throw error
      }

      const index = repository.rows.findIndex((row) => row.id === id)
      if (index === -1) return null

      const current = repository.rows[index] as Source
      const updated: Source = { ...current, ...patch, updatedAt: new Date() }
      repository.rows[index] = updated
      return updated
    },

    async deactivate(id: string): Promise<Source | null> {
      const index = repository.rows.findIndex((row) => row.id === id)
      if (index === -1) return null

      const current = repository.rows[index] as Source
      const updated: Source = { ...current, isActive: false, updatedAt: new Date() }
      repository.rows[index] = updated
      return updated
    },
  }

  return repository
}
