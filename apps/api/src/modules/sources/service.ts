import type { Source } from '@newsdeck/db/schema'
import { z } from 'zod'
import type { ListSourcesOptions, ListSourcesPage, SourcesRepository } from './repository.ts'

const feedUrlSchema = z.url({ protocol: /^https?$/ })

/**
 * Raised when a `feed_url` collides with an existing source.
 *
 * Kept distinct from a raw driver error so a caller can branch on it without
 * knowing anything about PostgreSQL or Drizzle. Mapping this to a
 * client-visible oRPC error is a later Issue's job.
 */
export class SourceFeedUrlConflictError extends Error {
  readonly feedUrl: string

  constructor(feedUrl: string) {
    super(`a source with feed url "${feedUrl}" already exists`)
    this.name = 'SourceFeedUrlConflictError'
    this.feedUrl = feedUrl
  }
}

/** Raised when a `feed_url` is not an absolute `http`/`https` URL. */
export class InvalidFeedUrlError extends Error {
  readonly feedUrl: string

  constructor(feedUrl: string) {
    super(`"${feedUrl}" is not an absolute http or https URL`)
    this.name = 'InvalidFeedUrlError'
    this.feedUrl = feedUrl
  }
}

/** Raised when an operation targets a source id that does not exist. */
export class SourceNotFoundError extends Error {
  readonly id: string

  constructor(id: string) {
    super(`no source with id "${id}" exists`)
    this.name = 'SourceNotFoundError'
    this.id = id
  }
}

export interface CreateSourceInput {
  name: string
  feedUrl: string
  siteUrl?: string | null
}

export interface UpdateSourceServiceInput {
  name?: string
  feedUrl?: string
  siteUrl?: string | null
}

export interface SourcesService {
  list(options?: ListSourcesOptions): Promise<ListSourcesPage>
  get(id: string): Promise<Source | null>
  create(input: CreateSourceInput): Promise<Source>
  update(id: string, patch: UpdateSourceServiceInput): Promise<Source>
  deactivate(id: string): Promise<Source>
}

/**
 * Insert races the existence check this service also runs before writing:
 * two concurrent creates for the same `feed_url` can both pass the check.
 * The database catches that case via the unique index; this recognises the
 * resulting driver error so it still surfaces as `SourceFeedUrlConflictError`
 * rather than a raw one.
 */
function isFeedUrlConflict(error: unknown): boolean {
  const cause = (error as { cause?: { code?: string; constraint_name?: string } } | undefined)
    ?.cause
  return cause?.code === '23505' && cause.constraint_name === 'sources_feed_url_unique'
}

function assertValidFeedUrl(feedUrl: string): void {
  if (!feedUrlSchema.safeParse(feedUrl).success) throw new InvalidFeedUrlError(feedUrl)
}

/**
 * Application logic for sources.
 *
 * Owns the rules a repository must not: uniqueness of `feed_url`, its format,
 * and what it means for an id to not exist. See
 * `apps/api/src/modules/system/service.ts` for the layer this copies.
 */
export function createSourcesService(repository: SourcesRepository): SourcesService {
  return {
    list(options) {
      return repository.list(options)
    },

    get(id) {
      return repository.findById(id)
    },

    async create(input) {
      assertValidFeedUrl(input.feedUrl)

      const existing = await repository.findByFeedUrl(input.feedUrl)
      if (existing !== null) throw new SourceFeedUrlConflictError(input.feedUrl)

      try {
        return await repository.insert({
          name: input.name,
          feedUrl: input.feedUrl,
          siteUrl: input.siteUrl ?? null,
        })
      } catch (error) {
        if (isFeedUrlConflict(error)) throw new SourceFeedUrlConflictError(input.feedUrl)
        throw error
      }
    },

    async update(id, patch) {
      const { feedUrl } = patch

      if (feedUrl !== undefined) {
        assertValidFeedUrl(feedUrl)

        const existing = await repository.findByFeedUrl(feedUrl)
        if (existing !== null && existing.id !== id) throw new SourceFeedUrlConflictError(feedUrl)
      }

      let updated: Source | null
      try {
        updated = await repository.update(id, patch)
      } catch (error) {
        if (feedUrl !== undefined && isFeedUrlConflict(error)) {
          throw new SourceFeedUrlConflictError(feedUrl)
        }
        throw error
      }

      if (updated === null) throw new SourceNotFoundError(id)
      return updated
    },

    async deactivate(id) {
      const updated = await repository.deactivate(id)
      if (updated === null) throw new SourceNotFoundError(id)
      return updated
    },
  }
}
