/**
 * Transport for the application API.
 *
 * Client-safe by construction — `@orpc/client`, `@orpc/tanstack-query` and the
 * contract, nothing else. The user web app, the admin app and a future Expo
 * app all build their client from here; each supplies its own base URL and
 * header strategy, because how you reach the API differs per host (same-origin
 * through the proxy in a browser, an absolute URL on a device).
 */

export type { ApiClient } from '@newsdeck/api-contract'
/** Narrows a caught error to the typed oRPC error a contract declares, e.g. by `.code`. */
export { isDefinedError, ORPCError } from '@orpc/client'
/** Builds the same TanStack Query bindings `createApiClient` returns, from any client shape — a fake in tests, the real one in `createApiClient`. */
export { createTanstackQueryUtils } from '@orpc/tanstack-query'
export {
  type ApiClientBundle,
  type CreateApiClientOptions,
  createApiClient,
} from './client.ts'
export { newRequestId, REQUEST_ID_HEADER } from './request-id.ts'
