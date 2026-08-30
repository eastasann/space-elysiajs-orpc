import { onError } from '@orpc/server'
import { RPCHandler } from '@orpc/server/fetch'
import type { RequestContext } from '../context.ts'
import { appRouter } from './router.ts'

/** Path the oRPC handler is mounted at, relative to the API root. */
export const RPC_PREFIX = '/rpc'

/**
 * Build the oRPC fetch handler.
 *
 * Interceptors are the transport-level place for cross-cutting concerns.
 * Unhandled errors are logged here — with the request's correlation id — and
 * then converted by oRPC into a client-safe payload; internal messages and
 * stack traces are never serialised to the caller.
 */
export function createRpcHandler(): RPCHandler<RequestContext> {
  return new RPCHandler(appRouter, {
    interceptors: [
      onError((error, options) => {
        const context = options.context as Partial<RequestContext> | undefined
        context?.logger?.error({ err: error }, 'rpc procedure failed')
      }),
    ],
  })
}
