import type { z } from 'zod'

/**
 * Raised when an environment schema cannot be satisfied.
 *
 * The message deliberately reports only variable names and validation
 * messages. Environment values frequently contain credentials, so they are
 * never echoed into logs or stack traces.
 */
export class EnvironmentError extends Error {
  readonly issues: readonly string[]

  constructor(issues: readonly string[]) {
    super(`Invalid environment configuration:\n${issues.map((i) => `  - ${i}`).join('\n')}`)
    this.name = 'EnvironmentError'
    this.issues = issues
  }
}

/**
 * Parse a raw environment record against a schema.
 *
 * `source` is passed explicitly rather than read from `process.env` inside the
 * helper so that configuration stays testable and so that this package carries
 * no runtime assumption about which JavaScript host it runs on.
 */
export function parseEnv<TSchema extends z.ZodType>(
  schema: TSchema,
  source: Record<string, string | undefined>,
): z.output<TSchema> {
  const result = schema.safeParse(source)

  if (!result.success) {
    const issues = result.error.issues.map((issue) => {
      const name = issue.path.join('.') || '(root)'
      return `${name}: ${issue.message}`
    })
    throw new EnvironmentError(issues)
  }

  return result.data
}
