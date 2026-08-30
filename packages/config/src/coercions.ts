import { z } from 'zod'

/** Parse a base-10 integer, rejecting values outside `[min, max]`. */
export function integerFromEnv(options: {
  default: number
  min?: number
  max?: number
}): z.ZodType<number> {
  const {
    default: defaultValue,
    min = Number.MIN_SAFE_INTEGER,
    max = Number.MAX_SAFE_INTEGER,
  } = options

  return z
    .string()
    .optional()
    .transform((value, ctx) => {
      if (value === undefined || value.trim() === '') return defaultValue

      const parsed = Number(value)
      if (!Number.isInteger(parsed)) {
        ctx.addIssue({ code: 'custom', message: 'must be an integer' })
        return z.NEVER
      }
      if (parsed < min || parsed > max) {
        ctx.addIssue({ code: 'custom', message: `must be between ${min} and ${max}` })
        return z.NEVER
      }
      return parsed
    })
}

/** Split a comma-separated variable into a trimmed, non-empty string list. */
export function stringList(defaultValue: readonly string[] = []): z.ZodType<string[]> {
  return z
    .string()
    .optional()
    .transform((value) => {
      if (value === undefined || value.trim() === '') return [...defaultValue]
      return value
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
    })
}
