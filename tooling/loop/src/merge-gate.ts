import type { ReviewResult, Severity } from './index.ts'
import type { RiskLevel } from './policy.ts'
import { blockingFindings } from './review.ts'

/**
 * What the automation has decided to do with a pull request.
 *
 * `blocked` is reserved for "automation stops, a human is needed". It is
 * deliberately distinct from `changes_requested`, which the fix loop can still
 * act on, so that a stalled loop is never mistaken for one still working.
 */
export type GateDecision =
  | 'auto_merge'
  | 'human_approval_required'
  | 'changes_requested'
  | 'blocked'
  | 'waiting'

export type CheckConclusion =
  | 'success'
  | 'failure'
  | 'pending'
  | 'skipped'
  | 'neutral'
  | 'cancelled'
  | 'timed_out'
  | 'missing'

export interface CheckState {
  name: string
  conclusion: CheckConclusion
}

export interface GateInput {
  risk: RiskLevel
  review: ReviewResult
  /** Observed state of every check run reported on the head commit. */
  checks: readonly CheckState[]
  /** Checks that must succeed. Missing ones count as pending, never as passing. */
  requiredChecks: readonly string[]
  reviewAttempts: number
  maxReviewAttempts: number
  /** Approving reviews from humans. Bot and author approvals are excluded upstream. */
  humanApprovals: number
  isFork: boolean
  isDraft: boolean
  blockingSeverity: Severity
}

export interface GateOutcome {
  decision: GateDecision
  reasons: string[]
  /** Conclusion to publish for the `loop/risk-gate` check run. */
  riskGate: 'success' | 'failure'
  /** Conclusion to publish for the `loop/review-gate` check run. */
  reviewGate: 'success' | 'failure'
  /** Whether the coding agent should be asked to address findings. */
  shouldDispatchFix: boolean
}

const PENDING: ReadonlySet<CheckConclusion> = new Set(['pending', 'missing'])

/**
 * Checks the gate publishes itself.
 *
 * They belong in the repository ruleset — that is what enforces them — but never
 * in this function's required list. Waiting for a check it is about to write
 * would deadlock the gate at `waiting` forever, and a misconfigured
 * `LOOP_REQUIRED_CHECKS` should not be able to cause that.
 */
export const SELF_PUBLISHED_CHECKS = ['loop/risk-gate', 'loop/review-gate'] as const

export function withoutSelfPublishedChecks(names: readonly string[]): string[] {
  return names.filter(
    (name) => !SELF_PUBLISHED_CHECKS.includes(name as (typeof SELF_PUBLISHED_CHECKS)[number]),
  )
}

function requiredCheckStates(input: GateInput): CheckState[] {
  return withoutSelfPublishedChecks(input.requiredChecks).map((name) => {
    const observed = input.checks.find((check) => check.name === name)
    // An absent check is pending, never passing. A gate that treats "no result"
    // as "no problem" can be bypassed by preventing the check from running.
    return observed ?? { name, conclusion: 'missing' as const }
  })
}

/**
 * Decide what may happen to a pull request.
 *
 * A pure function of observable facts, so every decision is reproducible and
 * testable. It grants nothing on its own: the workflow acts on the outcome by
 * publishing check runs and, at most, asking GitHub to enable *its* auto-merge.
 * GitHub still enforces the required checks, so a bug here cannot merge a pull
 * request that the repository ruleset would refuse.
 */
export function decideMerge(input: GateInput): GateOutcome {
  const reasons: string[] = []
  const required = requiredCheckStates(input)

  const failing = required.filter(
    (check) =>
      check.conclusion === 'failure' ||
      check.conclusion === 'timed_out' ||
      check.conclusion === 'cancelled',
  )
  const pending = required.filter((check) => PENDING.has(check.conclusion))
  const blocking = blockingFindings(input.review.findings, input.blockingSeverity)

  const reviewGate: 'success' | 'failure' =
    input.review.status === 'approve' && blocking.length === 0 ? 'success' : 'failure'

  const riskGate: 'success' | 'failure' =
    input.isFork || (input.risk === 'high' && input.humanApprovals === 0) ? 'failure' : 'success'

  if (reviewGate === 'failure') {
    reasons.push(
      input.review.status === 'approve'
        ? `${blocking.length} blocking finding(s) at or above ${input.blockingSeverity} severity`
        : `review agent returned ${input.review.status}`,
    )
  }
  if (riskGate === 'failure') {
    reasons.push(
      input.isFork
        ? 'pull request originates from a fork'
        : 'risk is high and no human approval is present',
    )
  }

  const outcome = (decision: GateDecision, shouldDispatchFix = false): GateOutcome => ({
    decision,
    reasons,
    riskGate,
    reviewGate,
    shouldDispatchFix,
  })

  if (input.isDraft) {
    reasons.unshift('pull request is a draft')
    return outcome('waiting')
  }

  if (input.review.status === 'blocked') {
    reasons.unshift('review agent reported blocked')
    return outcome('blocked')
  }

  const retriesExhausted = input.reviewAttempts >= input.maxReviewAttempts
  const needsWork = reviewGate === 'failure' || failing.length > 0

  if (needsWork && retriesExhausted) {
    reasons.unshift(
      `retry limit reached: ${input.reviewAttempts} of ${input.maxReviewAttempts} review attempts used`,
    )
    return outcome('blocked')
  }

  if (failing.length > 0) {
    reasons.unshift(`required check(s) failing: ${failing.map((c) => c.name).join(', ')}`)
    return outcome('changes_requested', !input.isFork)
  }

  if (reviewGate === 'failure') {
    return outcome('changes_requested', !input.isFork)
  }

  if (pending.length > 0) {
    reasons.unshift(`required check(s) not yet reported: ${pending.map((c) => c.name).join(', ')}`)
    return outcome('waiting')
  }

  if (riskGate === 'failure') {
    return outcome('human_approval_required')
  }

  reasons.unshift('all required checks passed and the review agent approved')
  return outcome('auto_merge')
}
