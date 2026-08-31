import { describe, expect, it } from 'bun:test'
import {
  createSourcesService,
  InvalidFeedUrlError,
  SourceFeedUrlConflictError,
  SourceNotFoundError,
} from '../../../src/modules/sources/service.ts'
import {
  fakeSource,
  fakeSourcesRepository,
  fakeUniqueViolation,
} from '../../support/fake-sources-repository.ts'

describe('create', () => {
  it('inserts a source with a valid, unique feed url', async () => {
    const repository = fakeSourcesRepository()
    const service = createSourcesService(repository)

    const created = await service.create({
      name: 'Example Feed',
      feedUrl: 'https://example.test/feed.xml',
    })

    expect(created.name).toBe('Example Feed')
    expect(created.feedUrl).toBe('https://example.test/feed.xml')
    expect(created.isActive).toBe(true)
    expect(repository.rows).toHaveLength(1)
  })

  it.each(['not-a-url', 'ftp://example.test/feed.xml', '/relative/feed.xml', ''])(
    'rejects %p as not an absolute http or https url',
    async (feedUrl) => {
      const repository = fakeSourcesRepository()
      const service = createSourcesService(repository)

      await expect(service.create({ name: 'Bad Feed', feedUrl })).rejects.toBeInstanceOf(
        InvalidFeedUrlError,
      )
      expect(repository.rows).toHaveLength(0)
    },
  )

  it('rejects a feed url that already exists with a domain error', async () => {
    const existing = fakeSource({ feedUrl: 'https://example.test/feed.xml' })
    const repository = fakeSourcesRepository([existing])
    const service = createSourcesService(repository)

    await expect(
      service.create({ name: 'Duplicate', feedUrl: 'https://example.test/feed.xml' }),
    ).rejects.toBeInstanceOf(SourceFeedUrlConflictError)
    expect(repository.rows).toHaveLength(1)
  })

  it('translates a unique-violation raised by a racing insert into the same domain error', async () => {
    const repository = fakeSourcesRepository()
    repository.failNextInsertWith = fakeUniqueViolation('sources_feed_url_unique')
    const service = createSourcesService(repository)

    await expect(
      service.create({ name: 'Example Feed', feedUrl: 'https://example.test/feed.xml' }),
    ).rejects.toBeInstanceOf(SourceFeedUrlConflictError)
  })

  it('does not swallow an unrelated insert failure', async () => {
    const repository = fakeSourcesRepository()
    const unrelated = new Error('connection reset')
    repository.failNextInsertWith = unrelated
    const service = createSourcesService(repository)

    await expect(
      service.create({ name: 'Example Feed', feedUrl: 'https://example.test/feed.xml' }),
    ).rejects.toBe(unrelated)
  })

  it('defaults a missing site url to null', async () => {
    const repository = fakeSourcesRepository()
    const service = createSourcesService(repository)

    const created = await service.create({
      name: 'Example Feed',
      feedUrl: 'https://example.test/feed.xml',
    })

    expect(created.siteUrl).toBeNull()
  })
})

describe('update', () => {
  it('applies a partial patch and reports the updated row', async () => {
    const existing = fakeSource({ name: 'Old Name' })
    const repository = fakeSourcesRepository([existing])
    const service = createSourcesService(repository)

    const updated = await service.update(existing.id, { name: 'New Name' })

    expect(updated.name).toBe('New Name')
    expect(updated.feedUrl).toBe(existing.feedUrl)
  })

  it('throws when the id does not exist', async () => {
    const repository = fakeSourcesRepository()
    const service = createSourcesService(repository)

    await expect(service.update('missing-id', { name: 'New Name' })).rejects.toBeInstanceOf(
      SourceNotFoundError,
    )
  })

  it('rejects an invalid feed url before writing', async () => {
    const existing = fakeSource()
    const repository = fakeSourcesRepository([existing])
    const service = createSourcesService(repository)

    await expect(service.update(existing.id, { feedUrl: 'not-a-url' })).rejects.toBeInstanceOf(
      InvalidFeedUrlError,
    )
  })

  it('rejects reusing another source’s feed url', async () => {
    const other = fakeSource({ feedUrl: 'https://example.test/taken.xml' })
    const target = fakeSource({ feedUrl: 'https://example.test/mine.xml' })
    const repository = fakeSourcesRepository([other, target])
    const service = createSourcesService(repository)

    await expect(
      service.update(target.id, { feedUrl: 'https://example.test/taken.xml' }),
    ).rejects.toBeInstanceOf(SourceFeedUrlConflictError)
  })

  it('allows re-submitting a source’s own current feed url', async () => {
    const target = fakeSource({ feedUrl: 'https://example.test/mine.xml' })
    const repository = fakeSourcesRepository([target])
    const service = createSourcesService(repository)

    const updated = await service.update(target.id, { feedUrl: 'https://example.test/mine.xml' })

    expect(updated.feedUrl).toBe('https://example.test/mine.xml')
  })
})

describe('deactivate', () => {
  it('flips is_active without deleting the row', async () => {
    const existing = fakeSource({ isActive: true })
    const repository = fakeSourcesRepository([existing])
    const service = createSourcesService(repository)

    const deactivated = await service.deactivate(existing.id)

    expect(deactivated.isActive).toBe(false)
    expect(repository.rows).toHaveLength(1)
  })

  it('throws when the id does not exist', async () => {
    const repository = fakeSourcesRepository()
    const service = createSourcesService(repository)

    await expect(service.deactivate('missing-id')).rejects.toBeInstanceOf(SourceNotFoundError)
  })
})

describe('get', () => {
  it('returns the source when it exists', async () => {
    const existing = fakeSource()
    const repository = fakeSourcesRepository([existing])
    const service = createSourcesService(repository)

    expect(await service.get(existing.id)).toEqual(existing)
  })

  it('returns null when it does not', async () => {
    const repository = fakeSourcesRepository()
    const service = createSourcesService(repository)

    expect(await service.get('missing-id')).toBeNull()
  })
})

describe('list', () => {
  it('delegates pagination to the repository', async () => {
    const sources = Array.from({ length: 3 }, () => fakeSource())
    const repository = fakeSourcesRepository(sources)
    const service = createSourcesService(repository)

    const page = await service.list({ page: 1, pageSize: 2 })

    expect(page.items).toHaveLength(2)
    expect(page.total).toBe(3)
  })
})
