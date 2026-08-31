import { base } from '../../rpc/base.ts'
import { SourceFeedUrlConflictError, SourceNotFoundError } from './service.ts'

interface ConflictErrors {
  CONFLICT: (options: { message: string; data: { feedUrl: string } }) => Error
}

interface NotFoundErrors {
  NOT_FOUND: (options: { message: string; data: { id: string } }) => Error
}

/** Translates the domain errors a write can raise into the typed oRPC errors the contract declares. */
async function withDomainErrors<T>(
  promise: Promise<T>,
  errors: Partial<ConflictErrors & NotFoundErrors>,
): Promise<T> {
  try {
    return await promise
  } catch (error) {
    if (error instanceof SourceFeedUrlConflictError && errors.CONFLICT !== undefined) {
      throw errors.CONFLICT({ message: error.message, data: { feedUrl: error.feedUrl } })
    }
    if (error instanceof SourceNotFoundError && errors.NOT_FOUND !== undefined) {
      throw errors.NOT_FOUND({ message: error.message, data: { id: error.id } })
    }
    throw error
  }
}

/**
 * Transport layer for the sources module.
 *
 * Handlers delegate to the service in one call; `withDomainErrors` is the
 * transport-level translation of a domain error into the contract's typed
 * oRPC error, not business logic.
 */
export const sourcesRouter = {
  list: base.sources.list.handler(({ input, context }) => context.services.sources.list(input)),

  get: base.sources.get.handler(({ input, context }) => context.services.sources.get(input.id)),

  create: base.sources.create.handler(({ input, context, errors }) =>
    withDomainErrors(context.services.sources.create(input), errors),
  ),

  update: base.sources.update.handler(({ input: { id, ...patch }, context, errors }) =>
    withDomainErrors(context.services.sources.update(id, patch), errors),
  ),

  deactivate: base.sources.deactivate.handler(({ input, context, errors }) =>
    withDomainErrors(context.services.sources.deactivate(input.id), errors),
  ),
}
