import { type SourcesFetchPayload, sourcesFetchJob, UnrecoverableError } from '@newsdeck/jobs'
import { FeedFetchError, fetchFeed } from '../lib/feed-fetcher.ts'
import type { SourcesRepository } from '../modules/sources/repository.ts'
import type { JobHandler } from './registry.ts'

export interface SourcesFetchHandlerOptions {
  repository: SourcesRepository
  /** Injection point for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch
  /** Injection point for tests; defaults to a real DNS lookup. */
  resolveHostname?: (hostname: string) => Promise<string[]>
}

/**
 * Fetches a source's feed document and records the outcome.
 *
 * Parsing the body, deduplicating it against existing articles and persisting
 * anything from it are later Issues' jobs — this one only proves the feed is
 * reachable and keeps the conditional-request bookkeeping current.
 */
export function createSourcesFetchHandler(
  options: SourcesFetchHandlerOptions,
): JobHandler<SourcesFetchPayload> {
  const { repository, fetchImpl, resolveHostname } = options

  return {
    definition: sourcesFetchJob,
    async process(payload, context) {
      const { logger } = context
      const source = await repository.findFetchTarget(payload.sourceId)
      if (source === null) {
        // The source can be deleted between enqueue and consumption; retrying
        // will never make it exist again.
        throw new UnrecoverableError(`no source with id "${payload.sourceId}" exists`)
      }

      try {
        const result = await fetchFeed({
          url: source.feedUrl,
          etag: source.etag,
          lastModified: source.lastModified,
          fetchImpl,
          resolveHostname,
        })

        if (result.status === 'not-modified') {
          await repository.recordFetchOutcome(source.id, { lastError: null })
          logger.info({ sourceId: source.id, outcome: 'not-modified' }, 'source fetch completed')
          return
        }

        await repository.recordFetchOutcome(source.id, {
          lastError: null,
          etag: result.etag,
          lastModified: result.lastModified,
        })
        logger.info(
          {
            sourceId: source.id,
            outcome: 'fetched',
            contentType: result.contentType,
            bytes: result.body.length,
          },
          'source fetch completed',
        )
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        await repository.recordFetchOutcome(source.id, { lastError: message })

        if (error instanceof FeedFetchError && !error.retryable) {
          logger.error(
            { sourceId: source.id, reason: error.reason, err: error },
            'source fetch failed permanently',
          )
          throw new UnrecoverableError(message)
        }

        logger.warn({ sourceId: source.id, err: error }, 'source fetch failed, will retry')
        throw error
      }
    },
  }
}
