import { z } from 'zod'

/**
 * What a workflow must hand the evaluator.
 *
 * Every field is read from a file or an environment variable, never from a
 * command line assembled by the workflow. Pull request titles, bodies and
 * branch names are attacker-controlled on a fork; interpolating them into a
 * shell command is the classic way a repository loses its token.
 */
export const EvaluationContextSchema = z.object({
  pullRequest: z.object({
    number: z.number().int().positive(),
    headSha: z.string().min(1).max(64),
    isDraft: z.boolean(),
    /** True when the head branch lives in another repository. */
    isFork: z.boolean(),
    labels: z.array(z.string()).max(100),
    body: z.string().nullable(),
  }),
  /** Labels of the issue this pull request closes, when it declares one. */
  issueLabels: z.array(z.string()).max(100).default([]),
  checks: z
    .array(
      z.object({
        name: z.string(),
        conclusion: z.enum([
          'success',
          'failure',
          'pending',
          'skipped',
          'neutral',
          'cancelled',
          'timed_out',
          'missing',
        ]),
      }),
    )
    .max(200),
  requiredChecks: z.array(z.string()).min(1),
  /** Approving reviews from humans. Bots and the author are filtered upstream. */
  humanApprovals: z.number().int().min(0),
  /** Body of the loop's sticky comment, if one exists. */
  stickyComment: z.string().nullable().default(null),
})
export type EvaluationContext = z.infer<typeof EvaluationContextSchema>

export const IssueListSchema = z.array(
  z.object({
    number: z.number().int().positive(),
    title: z.string(),
    state: z.enum(['open', 'closed']),
    labels: z.array(z.string()).max(100),
    body: z.string().nullable(),
  }),
)

/**
 * Fallback dependency map. Keys are issue numbers as strings, because JSON
 * object keys always are.
 */
export const FallbackDependenciesSchema = z
  .object({
    dependencies: z.record(z.string().regex(/^\d+$/), z.array(z.number().int().positive())),
  })
  .transform((value) => ({
    dependencies: Object.fromEntries(
      Object.entries(value.dependencies).map(([key, numbers]) => [Number(key), numbers]),
    ) as Record<number, number[]>,
  }))

const CLOSES_ISSUE = /\b(?:closes|fixes|resolves)\s+#(\d+)\b/i

/** The issue a pull request body declares it closes, if any. */
export function closingIssue(body: string | null): number | null {
  const match = body === null ? null : CLOSES_ISSUE.exec(body)
  return match?.[1] === undefined ? null : Number(match[1])
}
