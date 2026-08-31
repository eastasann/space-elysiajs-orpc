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

/**
 * A verification step, and the conditions under which it applies.
 *
 * `whenChanged` makes a step conditional on the diff actually touching
 * something it could break — running the Docker smoke test for a documentation
 * fix is waste, not rigour. `requires` names a tool that must be present:
 * a step that cannot run is never counted as passed, because "we could not
 * check" and "we checked and it was fine" are different answers.
 */
const TierStepSchema = z.object({
  name: z.string().min(1),
  command: z.string().min(1),
  args: z.array(z.string()),
  whenChanged: z.array(z.string().min(1)).optional(),
  /** A tool that must be on PATH for this step to run. */
  requires: z.string().min(1).optional(),
  /**
   * A command that must succeed before this step is considered runnable.
   *
   * `requires` proves a binary exists; this proves it works. `docker` on PATH
   * with a stopped daemon is the common case on a laptop that rebooted, and
   * without this the step would *fail* rather than report itself unavailable —
   * burning the issue's whole coding budget on something no agent can fix.
   */
  requiresProbe: z.array(z.string().min(1)).min(1).optional(),
  /** Minutes. Docker and E2E steps need far longer than a lint. */
  timeoutMinutes: z.number().int().min(1).max(180).default(20),
})
export type TierStep = z.infer<typeof TierStepSchema>

const TierSchema = z.object({
  /** Risk tier whose steps run before these. Tiers are cumulative. */
  inherits: RiskLevelSchema.optional(),
  steps: z.array(TierStepSchema),
  /** Independent review passes required at this tier. */
  reviewers: z.number().int().min(1).max(4),
})

export const LoopPolicySchema = z.object({
  retry: z.object({
    maxReviewAttempts: z.number().int().min(1).max(10),
    /** Implementation rounds spent on failing local verification. */
    codingFixRounds: z.number().int().min(1).max(10).default(3),
    /** Rounds spent addressing review findings. */
    reviewFixRounds: z.number().int().min(1).max(10).default(3),
    /** Rounds spent addressing failing CI. */
    ciFixRounds: z.number().int().min(1).max(10).default(3),
    /** Retries of a reviewer that returned unusable output. */
    reviewerRetryRounds: z.number().int().min(1).max(5).default(2),
    /** Attempts at resolving a merge conflict before blocking. */
    conflictRounds: z.number().int().min(1).max(5).default(2),
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
  /**
   * How much verification each risk level demands.
   *
   * This is the whole of the autonomous model: risk decides *how hard the
   * system checks its own work*, not whether a person is summoned. Every tier
   * can auto-merge; they differ only in what has to be true first.
   */
  tiers: z.object({
    low: TierSchema,
    medium: TierSchema,
    high: TierSchema,
  }),
  /**
   * The rules the loop uses to govern itself.
   *
   * An autonomous system that can rewrite its own merge policy has no merge
   * policy. Changes here are always high risk, always dual-reviewed, and are
   * additionally checked for whether they *weaken* the protections rather than
   * merely change them.
   */
  controlPlane: z.object({
    patterns: z.array(z.string().min(1)).min(1),
    /**
     * Content patterns that turn a documentation file into policy.
     *
     * `AGENTS.md` is mostly prose about where files live; correcting a command
     * in it is not a merge-policy change. A diff whose added or removed lines
     * match one of these is treated as policy-bearing and gets the control
     * plane's full treatment. Matching on the changed lines rather than the
     * file means the distinction is deterministic and reviewable.
     */
    policySignals: z.array(z.string().min(1)),
    /** Files that are policy no matter which lines changed. */
    alwaysPolicy: z.array(z.string().min(1)),
  }),
  review: z.object({
    blockingSeverity: SeveritySchema,
  }),
  /** Checks GitHub must be enforcing. Removing one is weakening a protection. */
  requiredChecks: z.array(z.string().min(1)).default([]),
})
export type LoopPolicy = z.infer<typeof LoopPolicySchema>

/** Every step for a risk level, with inherited tiers first and no duplicates. */
export function stepsForRisk(policy: LoopPolicy, risk: RiskLevel): TierStep[] {
  const seen = new Set<string>()
  const steps: TierStep[] = []

  const collect = (level: RiskLevel): void => {
    const tier = policy.tiers[level]
    if (tier.inherits !== undefined && tier.inherits !== level) collect(tier.inherits)
    for (const step of tier.steps) {
      if (seen.has(step.name)) continue
      seen.add(step.name)
      steps.push(step)
    }
  }

  collect(risk)
  return steps
}

/** Independent review passes required at a risk level. */
export function reviewersForRisk(policy: LoopPolicy, risk: RiskLevel): number {
  return policy.tiers[risk].reviewers
}

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
