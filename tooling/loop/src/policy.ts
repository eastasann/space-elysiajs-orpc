import { z } from 'zod'

export const RiskLevelSchema = z.enum(['low', 'medium', 'high'])
export type RiskLevel = z.infer<typeof RiskLevelSchema>

const RISK_ORDER: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2 }

/** The higher of two risk levels. Risk only ever moves upward (see `risk.ts`). */
export function maxRisk(a: RiskLevel, b: RiskLevel): RiskLevel {
  return RISK_ORDER[a] >= RISK_ORDER[b] ? a : b
}

export function isAtLeastRisk(value: RiskLevel, threshold: RiskLevel): boolean {
  return RISK_ORDER[value] >= RISK_ORDER[threshold]
}

export const SeveritySchema = z.enum(['info', 'low', 'medium', 'high', 'critical'])
export type Severity = z.infer<typeof SeveritySchema>

const SEVERITY_ORDER: Record<Severity, number> = {
  info: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
}

export function isAtLeastSeverity(value: Severity, threshold: Severity): boolean {
  return SEVERITY_ORDER[value] >= SEVERITY_ORDER[threshold]
}

const PathRuleSchema = z.object({
  risk: RiskLevelSchema,
  reason: z.string().min(1),
  patterns: z.array(z.string().min(1)).min(1),
})

export const LoopPolicySchema = z.object({
  retry: z.object({
    maxReviewAttempts: z.number().int().min(1).max(10),
  }),
  risk: z.object({
    default: RiskLevelSchema,
    paths: z.array(PathRuleSchema).min(1),
    escalations: z.object({
      maxChangedFiles: z.number().int().min(1),
      maxDeletedLines: z.number().int().min(1),
      destructiveMigrationGlobs: z.array(z.string()),
      publicContractGlobs: z.array(z.string()),
    }),
  }),
  review: z.object({
    blockingSeverity: SeveritySchema,
  }),
})
export type LoopPolicy = z.infer<typeof LoopPolicySchema>

export class PolicyError extends Error {
  constructor(issues: readonly string[]) {
    super(`Invalid loop policy:\n${issues.map((issue) => `  - ${issue}`).join('\n')}`)
    this.name = 'PolicyError'
  }
}

/**
 * Validate a parsed policy document.
 *
 * `$comment` keys are stripped first: the policy file carries its own rationale
 * inline, because a merge policy nobody can read is a merge policy nobody
 * audits.
 */
export function parsePolicy(raw: unknown): LoopPolicy {
  const result = LoopPolicySchema.safeParse(stripComments(raw))
  if (!result.success) {
    throw new PolicyError(
      result.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
    )
  }
  return result.data
}

function stripComments(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripComments)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => key !== '$comment')
        .map(([key, nested]) => [key, stripComments(nested)]),
    )
  }
  return value
}
