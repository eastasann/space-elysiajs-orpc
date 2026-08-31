import type { AuthIdentity } from '@newsdeck/auth'
import type { Logger } from '@newsdeck/logger'
import type { SourcesService } from './modules/sources/service.ts'
import type { SystemService } from './modules/system/service.ts'

/** Application services, constructed once per process and shared per request. */
export interface AppServices {
  system: SystemService
  sources: SourcesService
}

/**
 * What every oRPC procedure receives.
 *
 * Note what is NOT here: no database handle, no Redis client, no raw request.
 * Procedures talk to services; services own infrastructure. That is the rule
 * that keeps business logic out of transport handlers.
 */
export interface RequestContext {
  /** Correlation id, propagated in and out via `x-request-id`. */
  requestId: string
  /** Child logger already bound to `requestId`. */
  logger: Logger
  /**
   * The verified caller, or `null` when the request carried no usable
   * credential. Resolving this to an application user is Milestone 2 work; no
   * procedure requires it yet.
   */
  identity: AuthIdentity | null
  services: AppServices
}
