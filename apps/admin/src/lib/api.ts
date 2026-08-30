import { createApiClient, newRequestId, REQUEST_ID_HEADER } from '@newsdeck/api-client'
import { createIsomorphicFn } from '@tanstack/react-start'
import { getRequestHeader } from '@tanstack/react-start/server'

/**
 * Where this app reaches the API.
 *
 * In the browser the call is same-origin (`/api/...`): the reverse proxy — or
 * the Vite dev server standing in for it — forwards it.
 *
 * During SSR the request is made inside the private network, so an absolute URL
 * is required.
 */
const resolveBaseUrl = createIsomorphicFn()
  .server(() => {
    const base = process.env.SERVER_API_URL ?? 'http://localhost:3001'
    return `${base.replace(/\/+$/, '')}/rpc`
  })
  // Same origin as the page, resolved at runtime: nothing about where the API
  // lives is baked into the client bundle, so one built image serves any
  // environment. It must be absolute — the oRPC link parses it with `new URL`.
  .client(() => `${window.location.origin}/api/rpc`)

/**
 * Reuse the browser's correlation id during SSR so that one page view produces
 * a single traceable id across the web server and the API. `createIsomorphicFn`
 * keeps `getRequestHeader` — server-only code — out of the client bundle.
 */
const resolveRequestId = createIsomorphicFn()
  .server(() => getRequestHeader(REQUEST_ID_HEADER) ?? newRequestId())
  .client(() => newRequestId())

const { client, orpc } = createApiClient({
  baseUrl: resolveBaseUrl() as string,
  requestId: () => resolveRequestId() as string,
})

export { client as apiClient, orpc }
