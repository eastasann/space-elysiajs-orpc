import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { eq, sql } from 'drizzle-orm'
import type { DatabaseHandle } from '../src/index.ts'
import { createDatabase, probeDatabase, runMigrations } from '../src/index.ts'
import { categories, sources, userIdentities, users } from '../src/schema/index.ts'
import { seedCategories } from '../src/seed-categories.ts'

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL

/**
 * Narrow an optional row to a present one.
 *
 * `.returning()` is typed as an array, so every insert would otherwise need a
 * non-null assertion — which would hide a genuinely missing row behind a
 * confusing `undefined` error later in the test.
 */
function required<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`expected ${what} to have been returned`)
  return value
}

/**
 * Integration coverage for the persistence layer. Requires a real PostgreSQL
 * instance; see docs/development.md#testing. Skipped — loudly — when
 * TEST_DATABASE_URL is unset so that `bun run test` stays usable offline.
 */
describe.skipIf(!TEST_DATABASE_URL)('database migrations and constraints', () => {
  let handle: DatabaseHandle

  beforeAll(async () => {
    handle = createDatabase({ url: TEST_DATABASE_URL as string, maxConnections: 2 })
    await runMigrations(handle)
    await handle.db.execute(sql`truncate table ${users} restart identity cascade`)
    await handle.db.execute(sql`truncate table ${sources} restart identity cascade`)
    await handle.db.execute(sql`truncate table ${categories} restart identity cascade`)
  })

  afterAll(async () => {
    if (handle !== undefined) await handle.close()
  })

  it('creates the bootstrap tables', async () => {
    const rows = await handle.sql<{ table_name: string }[]>`
      select table_name from information_schema.tables
      where table_schema = 'public' order by table_name
    `
    const names = rows.map((row) => row.table_name)

    expect(names).toContain('users')
    expect(names).toContain('user_identities')
    expect(names).toContain('sources')
    expect(names).toContain('categories')
  })

  it('is idempotent when applied twice', async () => {
    await runMigrations(handle)
    const rows = await handle.sql<{ count: string }[]>`
      select count(*)::text as count from information_schema.tables
      where table_schema = 'public' and table_name = 'users'
    `
    expect(rows[0]?.count).toBe('1')
  })

  it('round-trips a user and a linked identity', async () => {
    const [inserted] = await handle.db
      .insert(users)
      .values({ email: 'reader@example.test', displayName: 'Reader' })
      .returning()
    const user = required(inserted, 'user')

    expect(user.id).toMatch(/^[0-9a-f-]{36}$/)

    await handle.db
      .insert(userIdentities)
      .values({ userId: user.id, provider: 'local', providerUserId: 'local|reader' })

    const linked = await handle.db.query.users.findFirst({
      where: eq(users.id, user.id),
      with: { identities: true },
    })

    expect(linked?.identities).toHaveLength(1)
    expect(linked?.identities[0]?.provider).toBe('local')
    // The provider subject is stored beside the user, never as the user's id.
    expect(linked?.id).not.toBe('local|reader')
  })

  it('rejects a second identity for the same provider subject', async () => {
    const other = required(
      (
        await handle.db
          .insert(users)
          .values({ email: 'other@example.test', displayName: 'Other' })
          .returning()
      )[0],
      'user',
    )

    let caught: unknown
    try {
      await handle.db
        .insert(userIdentities)
        .values({ userId: other.id, provider: 'local', providerUserId: 'local|reader' })
    } catch (error) {
      caught = error
    }

    // Drizzle wraps the driver error; the constraint name lives on the cause.
    const cause = (caught as { cause?: { constraint_name?: string; code?: string } } | undefined)
      ?.cause

    expect(caught).toBeDefined()
    expect(cause?.code).toBe('23505')
    expect(cause?.constraint_name).toBe('user_identities_provider_subject_unique')
  })

  it('cascades identity deletion with the user', async () => {
    const [inserted] = await handle.db
      .insert(users)
      .values({ email: 'temp@example.test', displayName: 'Temp' })
      .returning()
    const temp = required(inserted, 'user')

    await handle.db
      .insert(userIdentities)
      .values({ userId: temp.id, provider: 'local', providerUserId: 'local|temp' })

    await handle.db.delete(users).where(eq(users.id, temp.id))

    const remaining = await handle.db
      .select()
      .from(userIdentities)
      .where(eq(userIdentities.userId, temp.id))
    expect(remaining).toHaveLength(0)
  })

  it('reports a healthy probe', async () => {
    const result = await probeDatabase(handle)

    expect(result.ok).toBe(true)
    expect(result.latencyMs).toBeGreaterThanOrEqual(0)
  })

  it('inserts a source and rejects a duplicate feed url', async () => {
    const [inserted] = await handle.db
      .insert(sources)
      .values({ name: 'Example Feed', feedUrl: 'https://example.test/feed.xml' })
      .returning()
    const source = required(inserted, 'source')

    expect(source.isActive).toBe(true)

    let caught: unknown
    try {
      await handle.db
        .insert(sources)
        .values({ name: 'Duplicate Feed', feedUrl: 'https://example.test/feed.xml' })
    } catch (error) {
      caught = error
    }

    const cause = (caught as { cause?: { constraint_name?: string; code?: string } } | undefined)
      ?.cause

    expect(caught).toBeDefined()
    expect(cause?.code).toBe('23505')
    expect(cause?.constraint_name).toBe('sources_feed_url_unique')
  })

  it('rejects a second category with the same slug', async () => {
    await handle.db.insert(categories).values({ slug: 'world', name: 'World', displayOrder: 0 })

    let caught: unknown
    try {
      await handle.db
        .insert(categories)
        .values({ slug: 'world', name: 'Also World', displayOrder: 1 })
    } catch (error) {
      caught = error
    }

    const cause = (caught as { cause?: { constraint_name?: string; code?: string } } | undefined)
      ?.cause

    expect(caught).toBeDefined()
    expect(cause?.code).toBe('23505')
    expect(cause?.constraint_name).toBe('categories_slug_unique')
  })

  it('seeds categories idempotently', async () => {
    const first = await seedCategories(handle.db)
    const rowsAfterFirst = await handle.db.select().from(categories)

    const second = await seedCategories(handle.db)
    const rowsAfterSecond = await handle.db.select().from(categories)

    expect(first).toBe(second)
    expect(rowsAfterSecond).toHaveLength(rowsAfterFirst.length)
    expect(new Set(rowsAfterSecond.map((row) => row.slug)).size).toBe(rowsAfterSecond.length)
  })
})

describe('probeDatabase', () => {
  it('reports failure without leaking the connection string', async () => {
    const unreachable = createDatabase({
      url: 'postgres://nobody:hunter2@127.0.0.1:1/none',
      connectTimeoutSeconds: 1,
    })

    const result = await probeDatabase(unreachable, 500)

    expect(result.ok).toBe(false)
    expect(result.detail ?? '').not.toContain('hunter2')
    await unreachable.close().catch(() => {})
  })
})
