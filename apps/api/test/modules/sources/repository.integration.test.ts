import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import type { DatabaseHandle } from '@newsdeck/db'
import { createDatabase, runMigrations } from '@newsdeck/db'
import { sources } from '@newsdeck/db/schema'
import { sql } from 'drizzle-orm'
import {
  createSourcesRepository,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  type SourcesRepository,
} from '../../../src/modules/sources/repository.ts'

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL

/**
 * Integration coverage for the sources repository. Requires a real
 * PostgreSQL instance; see docs/development.md#testing. Skipped — loudly —
 * when TEST_DATABASE_URL is unset so that `bun run test` stays usable
 * offline.
 */
describe.skipIf(!TEST_DATABASE_URL)('sources repository', () => {
  let handle: DatabaseHandle
  let repository: SourcesRepository

  beforeAll(async () => {
    handle = createDatabase({ url: TEST_DATABASE_URL as string, maxConnections: 2 })
    await runMigrations(handle)
    repository = createSourcesRepository(handle)
  })

  afterAll(async () => {
    if (handle !== undefined) await handle.close()
  })

  async function reset(): Promise<void> {
    await handle.db.execute(sql`truncate table ${sources} restart identity cascade`)
  }

  it('inserts a source and finds it by id and by feed url', async () => {
    await reset()

    const created = await repository.insert({
      name: 'Example Feed',
      feedUrl: 'https://example.test/feed.xml',
    })

    expect(created.isActive).toBe(true)
    expect(await repository.findById(created.id)).toEqual(created)
    expect(await repository.findByFeedUrl('https://example.test/feed.xml')).toEqual(created)
  })

  it('reports absence as null rather than throwing', async () => {
    await reset()

    expect(await repository.findById('00000000-0000-0000-0000-000000000000')).toBeNull()
    expect(await repository.findByFeedUrl('https://example.test/nowhere.xml')).toBeNull()
  })

  it('updates only the fields given', async () => {
    await reset()

    const created = await repository.insert({
      name: 'Original Name',
      feedUrl: 'https://example.test/feed.xml',
      siteUrl: 'https://example.test',
    })

    const updated = await repository.update(created.id, { name: 'New Name' })

    expect(updated?.name).toBe('New Name')
    expect(updated?.feedUrl).toBe('https://example.test/feed.xml')
    expect(updated?.siteUrl).toBe('https://example.test')
    expect(updated?.updatedAt.getTime()).toBeGreaterThanOrEqual(created.updatedAt.getTime())
  })

  it('returns null from update when the id does not exist', async () => {
    await reset()

    expect(
      await repository.update('00000000-0000-0000-0000-000000000000', { name: 'New Name' }),
    ).toBeNull()
  })

  it('deactivates a source without deleting it', async () => {
    await reset()

    const created = await repository.insert({
      name: 'Example Feed',
      feedUrl: 'https://example.test/feed.xml',
    })

    const deactivated = await repository.deactivate(created.id)

    expect(deactivated?.isActive).toBe(false)
    expect(await repository.findById(created.id)).toMatchObject({ isActive: false })
  })

  it('returns null from deactivate when the id does not exist', async () => {
    await reset()

    expect(await repository.deactivate('00000000-0000-0000-0000-000000000000')).toBeNull()
  })

  it('paginates with a stable order and reports the total across all pages', async () => {
    await reset()

    for (let index = 0; index < 5; index += 1) {
      await repository.insert({
        name: `Feed ${index}`,
        feedUrl: `https://example.test/feed-${index}.xml`,
      })
    }

    const firstPage = await repository.list({ page: 1, pageSize: 2 })
    const secondPage = await repository.list({ page: 2, pageSize: 2 })

    expect(firstPage.items).toHaveLength(2)
    expect(firstPage.total).toBe(5)
    expect(secondPage.items).toHaveLength(2)
    expect(secondPage.total).toBe(5)

    const seenIds = new Set([...firstPage.items, ...secondPage.items].map((row) => row.id))
    expect(seenIds.size).toBe(4)
  })

  it('bounds page size to a maximum instead of returning everything', async () => {
    await reset()

    for (let index = 0; index < 3; index += 1) {
      await repository.insert({
        name: `Feed ${index}`,
        feedUrl: `https://example.test/feed-${index}.xml`,
      })
    }

    const page = await repository.list({ pageSize: MAX_PAGE_SIZE + 500 })

    expect(page.items.length).toBeLessThanOrEqual(MAX_PAGE_SIZE)
  })

  it('applies a default page size when none is given', async () => {
    await reset()

    await repository.insert({ name: 'Feed', feedUrl: 'https://example.test/feed.xml' })

    const page = await repository.list()

    expect(page.items.length).toBeLessThanOrEqual(DEFAULT_PAGE_SIZE)
  })
})
