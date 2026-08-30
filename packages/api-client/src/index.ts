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
export {
  type ApiClientBundle,
  type CreateApiClientOptions,
  createApiClient,
} from './client.ts'
export { newRequestId, REQUEST_ID_HEADER } from './request-id.ts'
