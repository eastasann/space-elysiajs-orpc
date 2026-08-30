/**
 * A caller as described by an external authentication provider, normalised
 * into the shape the application understands.
 *
 * Deliberately absent: the application user id. Resolving an identity to a
 * `users.id` is a persistence concern (see `user_identities`), not something a
 * provider may dictate. Keeping the two apart is what allows providers to be
 * swapped, or several to be linked to one account.
 *
 * Also deliberately absent: raw provider claims. Letting them through would
 * spread provider-specific vocabulary across the domain.
 */
export interface AuthIdentity {
  /** Provider key, matching `AuthProvider.name` and `user_identities.provider`. */
  readonly provider: string
  /** The provider's opaque subject identifier. Never used as an application id. */
  readonly providerUserId: string
  readonly email: string | null
  readonly displayName: string | null
}

/** Contract every authentication provider adapter implements. */
export interface AuthProvider {
  readonly name: string
  /**
   * Verify a bearer credential.
   *
   * Returns `null` for any credential that is absent, malformed, expired, or
   * not addressed to this application — the caller cannot distinguish between
   * those cases, and should not. Throwing is reserved for provider outages so
   * that a misconfigured provider does not read as "everyone is anonymous".
   */
  verifyToken(token: string): Promise<AuthIdentity | null>
}

const BEARER_PREFIX = /^Bearer\s+(.+)$/i

/** Extract a bearer token from an `Authorization` header, if present. */
export function readBearerToken(headers: { get(name: string): string | null }): string | null {
  const header = headers.get('authorization')
  if (header === null) return null

  const match = BEARER_PREFIX.exec(header.trim())
  return match?.[1]?.trim() ?? null
}
