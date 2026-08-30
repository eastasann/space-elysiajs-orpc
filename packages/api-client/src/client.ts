import type { ApiClient } from '@newsdeck/api-contract'
import { createORPCClient } from '@orpc/client'
import { RPCLink } from '@orpc/client/fetch'
import { createTanstackQueryUtils } from '@orpc/tanstack-query'
import { newRequestId, REQUEST_ID_HEADER } from './request-id.ts'

export interface CreateApiClientOptions {
  /**
   * Absolute base URL of the oRPC endpoint.
   *
   * Must be absolute: the link resolves it with `new URL(baseUrl)`, which
   * throws on a bare path. Browser callers should build a same-origin absolute
   * URL from `window.location.origin` so that no host is baked into the bundle.
   */
  baseUrl: string
  /**
   * Correlation id to attach to each call. Supply the inbound request's id
   * during SSR so one browser request produces one trace; omit it to have a
   * fresh id generated per call.
   */
  requestId?: () => string
  /** Extra headers, e.g. `Authorization`. Evaluated per call. */
  headers?: () => Record<string, string>
}

export interface ApiClientBundle {
  /** Direct, fully typed procedure calls. */
  client: ApiClient
  /** TanStack Query bindings: `orpc.system.status.queryOptions()`. */
  orpc: ReturnType<typeof createTanstackQueryUtils<ApiClient>>
}

export function createApiClient(options: CreateApiClientOptions): ApiClientBundle {
  assertAbsoluteUrl(options.baseUrl)

  const link = new RPCLink({
    url: options.baseUrl,
    headers: () => ({
      [REQUEST_ID_HEADER]: options.requestId?.() ?? newRequestId(),
      ...options.headers?.(),
    }),
  })

  const client: ApiClient = createORPCClient(link)

  return { client, orpc: createTanstackQueryUtils(client) }
}

/**
 * Fail at construction rather than on the first call.
 *
 * A relative `baseUrl` looks plausible and works in every server-side test, but
 * throws inside the transport in a browser — where the failure surfaces as an
 * opaque per-call error, far from its cause.
 */
function assertAbsoluteUrl(baseUrl: string): void {
  try {
    new URL(baseUrl)
  } catch {
    throw new TypeError(
      `createApiClient: baseUrl must be absolute, received ${JSON.stringify(baseUrl)}. ` +
        'In a browser, build one from window.location.origin.',
    )
  }
}
