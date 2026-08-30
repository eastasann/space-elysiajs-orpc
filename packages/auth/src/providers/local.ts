import { jwtVerify, SignJWT } from 'jose'
import type { AuthIdentity, AuthProvider } from '../identity.ts'

/** Only HS256 is accepted. Pinning the algorithm blocks `alg` confusion attacks. */
const ALGORITHM = 'HS256'

export const LOCAL_PROVIDER_NAME = 'local'

export interface LocalAuthProviderOptions {
  /** Symmetric signing key. Local development only — see docs/architecture.md. */
  signingKey: string
  issuer: string
  audience: string
}

function encodeKey(signingKey: string): Uint8Array {
  return new TextEncoder().encode(signingKey)
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

/**
 * Development authentication provider.
 *
 * Verifies JWTs this repository signs itself, so the whole stack runs without
 * an account at Clerk, Auth0, Firebase, Cognito or anywhere else. It implements
 * exactly the same `AuthProvider` contract a hosted provider adapter will, so
 * swapping providers is a configuration change rather than a redesign.
 */
export function createLocalAuthProvider(options: LocalAuthProviderOptions): AuthProvider {
  const key = encodeKey(options.signingKey)

  return {
    name: LOCAL_PROVIDER_NAME,

    async verifyToken(token: string): Promise<AuthIdentity | null> {
      try {
        const { payload } = await jwtVerify(token, key, {
          algorithms: [ALGORITHM],
          issuer: options.issuer,
          audience: options.audience,
        })

        const subject = asNonEmptyString(payload.sub)
        if (subject === null) return null

        return {
          provider: LOCAL_PROVIDER_NAME,
          providerUserId: subject,
          email: asNonEmptyString(payload.email),
          displayName: asNonEmptyString(payload.name),
        }
      } catch {
        // Signature, expiry, issuer and audience failures are all "not
        // authenticated" from the caller's point of view.
        return null
      }
    },
  }
}

export interface LocalTokenClaims {
  subject: string
  email?: string
  displayName?: string
  /** Lifetime in seconds. Defaults to one hour. */
  expiresInSeconds?: number
}

/**
 * Mint a token the local provider will accept.
 *
 * DEVELOPMENT AND TEST USE ONLY. There is no hosted counterpart: production
 * deployments obtain tokens from a real identity provider. It lives here so
 * that tests, seed scripts and manual API exploration do not each reinvent it.
 */
export async function issueLocalToken(
  options: LocalAuthProviderOptions,
  claims: LocalTokenClaims,
): Promise<string> {
  const builder = new SignJWT({
    ...(claims.email === undefined ? {} : { email: claims.email }),
    ...(claims.displayName === undefined ? {} : { name: claims.displayName }),
  })
    .setProtectedHeader({ alg: ALGORITHM })
    .setSubject(claims.subject)
    .setIssuer(options.issuer)
    .setAudience(options.audience)
    .setIssuedAt()
    .setExpirationTime(`${claims.expiresInSeconds ?? 3600}s`)

  return builder.sign(encodeKey(options.signingKey))
}
