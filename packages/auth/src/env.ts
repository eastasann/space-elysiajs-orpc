import { z } from 'zod'
import { LOCAL_PROVIDER_NAME } from './providers/local.ts'

/**
 * Providers this repository can construct today.
 *
 * Hosted providers (Clerk, Auth0, Firebase, Cognito, any OIDC issuer) are added
 * by writing an adapter that satisfies `AuthProvider` and extending this enum —
 * no domain code changes.
 */
export const SUPPORTED_AUTH_PROVIDERS = [LOCAL_PROVIDER_NAME] as const

export const authEnvSchema = z.object({
  AUTH_PROVIDER: z.enum(SUPPORTED_AUTH_PROVIDERS).default(LOCAL_PROVIDER_NAME),
  AUTH_ISSUER: z.string().min(1).default('newsdeck-local'),
  AUTH_AUDIENCE: z.string().min(1).default('newsdeck'),
  AUTH_LOCAL_SIGNING_KEY: z.string().min(16, 'must be at least 16 characters'),
})

export type AuthEnv = z.infer<typeof authEnvSchema>
