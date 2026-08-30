import type { AuthIdentity, AuthProvider } from '@newsdeck/auth'
import { readBearerToken } from '@newsdeck/auth'
import type { Logger } from '@newsdeck/logger'

/**
 * Resolve the caller's identity at the transport edge.
 *
 * Runs for every RPC request and never rejects one: procedures that require a
 * caller will enforce that themselves (Milestone 2). Verification is stateless
 * — no server-side session is consulted — which is what allows any API replica
 * behind the load balancer to serve any request.
 */
export async function resolveIdentity(
  headers: Headers,
  provider: AuthProvider,
  logger: Logger,
): Promise<AuthIdentity | null> {
  const token = readBearerToken(headers)
  if (token === null) return null

  try {
    return await provider.verifyToken(token)
  } catch (error) {
    // A provider outage must not be reported as "anonymous", but it also must
    // not take the whole request down while nothing requires authentication.
    logger.error({ err: error, provider: provider.name }, 'auth provider verification failed')
    return null
  }
}
