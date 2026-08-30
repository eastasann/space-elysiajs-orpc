import type { AuthEnv } from './env.ts'
import type { AuthProvider } from './identity.ts'
import { createLocalAuthProvider, LOCAL_PROVIDER_NAME } from './providers/local.ts'

/**
 * Build the configured provider.
 *
 * This function is the single place that knows which concrete adapters exist.
 * Everything downstream — middleware, services, repositories — depends only on
 * the `AuthProvider` interface.
 */
export function createAuthProvider(env: AuthEnv): AuthProvider {
  switch (env.AUTH_PROVIDER) {
    case LOCAL_PROVIDER_NAME:
      return createLocalAuthProvider({
        signingKey: env.AUTH_LOCAL_SIGNING_KEY,
        issuer: env.AUTH_ISSUER,
        audience: env.AUTH_AUDIENCE,
      })
    default: {
      // Exhaustiveness guard: adding a provider to the enum without an adapter
      // here becomes a compile error rather than a runtime surprise.
      const unsupported: never = env.AUTH_PROVIDER
      throw new Error(`Unsupported AUTH_PROVIDER: ${String(unsupported)}`)
    }
  }
}
