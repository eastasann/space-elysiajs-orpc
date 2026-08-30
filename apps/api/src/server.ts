import { cors } from '@elysiajs/cors'
import type { AuthProvider } from '@newsdeck/auth'
import type { Logger } from '@newsdeck/logger'
import { REQUEST_ID_HEADER, readRequestId } from '@newsdeck/logger'
import { Elysia } from 'elysia'
import type { AppServices } from './context.ts'
import { createRpcHandler, RPC_PREFIX } from './rpc/handler.ts'
import { resolveIdentity } from './rpc/identity.ts'

export interface ServerDependencies {
  logger: Logger
  instanceId: string
  services: AppServices
  authProvider: AuthProvider
  /** Origins permitted to call the API cross-origin. Empty disables CORS. */
  corsOrigins: readonly string[]
  startedAt: number
}

/**
 * Build the HTTP surface.
 *
 * Kept separate from `index.ts` so tests can construct a server over fake or
 * real services without starting a listener or reading the environment.
 */
export function buildServer(deps: ServerDependencies) {
  const rpcHandler = createRpcHandler()

  const app = new Elysia({ name: 'newsdeck-api' })
    .derive({ as: 'global' }, ({ request, set }) => {
      const requestId = readRequestId(request.headers)
      // Echo the correlation id so a caller can quote it in a bug report and
      // so downstream hops reuse the same id.
      set.headers[REQUEST_ID_HEADER] = requestId

      return {
        requestId,
        log: deps.logger.child({ requestId }),
        receivedAt: performance.now(),
        // Captured here because Elysia's after-response context does not carry
        // a usable `request`.
        method: request.method,
        path: new URL(request.url).pathname,
      }
    })
    .onAfterResponse({ as: 'global' }, (context) => {
      // Elysia skips `derive` for requests that match no route, so the derived
      // fields can be absent here. Those responses are logged by `onError`.
      const { set, log, receivedAt, method, path } = context as Partial<typeof context>
      if (log === undefined || receivedAt === undefined) return

      // `log` is already bound to the request id; repeating it here would
      // duplicate the field in every record.
      log.info(
        {
          method,
          path,
          status: set?.status,
          durationMs: Math.round(performance.now() - receivedAt),
        },
        'request completed',
      )
    })
    .onError({ as: 'global' }, ({ error, code, set, request, path }) => {
      // Elysia emits the string 'NOT_FOUND' at runtime, but its type for a
      // globally scoped error handler omits that member; compare as a string
      // rather than narrowing the union incorrectly.
      const notFound = String(code) === 'NOT_FOUND'
      // A 404 is routine traffic, not an incident; only real failures are
      // logged at error level so that alerting stays meaningful.
      const record = { err: error, code, method: request.method, path }
      if (notFound) deps.logger.warn(record, 'route not found')
      else deps.logger.error(record, 'unhandled request error')

      set.status = notFound ? 404 : 500
      // Never serialise internal messages or stack traces to a caller.
      return { error: notFound ? 'not_found' : 'internal_error' }
    })

    /**
     * Liveness. Answers from process state only — no database, no Redis — so
     * that a dependency outage never causes the orchestrator to kill otherwise
     * healthy replicas. `instanceId` makes this the cheapest way to observe
     * load balancing.
     */
    .get('/health', () => ({
      status: 'ok' as const,
      service: 'api' as const,
      instanceId: deps.instanceId,
      uptimeSeconds: Math.round((Date.now() - deps.startedAt) / 1000),
    }))

    /** Readiness. Checks the dependencies this replica needs to serve traffic. */
    .get('/ready', async ({ set }) => {
      const ready = await deps.services.system.isReady()
      set.status = ready ? 200 : 503
      return {
        status: ready ? ('ready' as const) : ('unready' as const),
        instanceId: deps.instanceId,
      }
    })

    /** The application API. Everything of substance is an oRPC procedure. */
    .all(`${RPC_PREFIX}/*`, async ({ request, requestId, log, set }) => {
      const identity = await resolveIdentity(request.headers, deps.authProvider, log)

      const { matched, response } = await rpcHandler.handle(request, {
        prefix: RPC_PREFIX,
        context: { requestId, logger: log, identity, services: deps.services },
      })

      if (!matched) {
        set.status = 404
        return { error: 'not_found' }
      }
      return response
    })

  return deps.corsOrigins.length === 0
    ? app
    : app.use(cors({ origin: [...deps.corsOrigins], credentials: true }))
}

export type ApiServer = ReturnType<typeof buildServer>
