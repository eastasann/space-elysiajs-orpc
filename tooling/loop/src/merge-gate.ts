import { aggregateReviews } from './aggregate.ts'
import type { RiskLevel, Severity } from './policy.ts'
import type { Finding, ReviewResult } from './review.ts'

/**
 * What the automation has decided to do with a pull request.
 *
 * `blocked` means "automation has stopped on this pull request" — not "the loop
 * has stopped". A blocked pull request leaves its issue labelled
 * `agent:blocked` and the runner moves to independent work; only a person can
 * unblock it, but nothing waits on them.
 *
 * `human_approval_required` is deliberately rare. Risk alone never produces it:
 * a high-risk change is verified harder, not escalated to a person. It survives
 * for the three cases where autonomy genuinely cannot decide — a fork, a change
 * that weakens the loop's own protections, and an explicit human hold.
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

/** Label a person can apply to take a pull request out of the loop's hands. */
export const HUMAN_HOLD_LABEL = 'needs:human'

export interface GateInput {
  risk: RiskLevel
  /**
   * One entry per independent review pass that produced a usable result.
   *
   * A tier requiring two reviewers and receiving one is short of an opinion,
   * not in possession of a favourable one — `aggregateReviews` blocks on that.
   */
  reviews: readonly ReviewResult[]
  /** Independent review passes this risk tier demands. */
  requiredReviewers: number
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
  /** Findings from the control-plane comparison. Non-empty means weakening. */
  weakenedProtections?: readonly Finding[]
  /** True when a person applied `needs:human`. */
  humanHold?: boolean
  /**
   * Verification the runner performed locally, by tier.
   *
   * A step the tier requires that could not run — no Docker, for instance — is
   * reported here as unavailable and blocks. "We could not check" is not a pass.
   */
  tierVerification?: {
    ok: boolean
    unavailable: readonly string[]
    failed: readonly string[]
  }
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
  /** The aggregated review, for the pull request comment. */
  review: ReviewResult
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
 * request the repository ruleset would refuse.
 *
 * The order below is the safety argument. Everything that can stop a merge is
 * evaluated before anything that can permit one, and each stop returns
 * immediately, so no later branch can undo an earlier objection.
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

  const aggregate = aggregateReviews({
    reviews: input.reviews,
    required: input.requiredReviewers,
    blockingSeverity: input.blockingSeverity,
  })
  const review: ReviewResult = {
    status: aggregate.status,
    findings: aggregate.findings,
    summary: aggregate.summary,
  }

  const weakened = input.weakenedProtections ?? []
  const reviewGate: 'success' | 'failure' = aggregate.status === 'approve' ? 'success' : 'failure'

  // The risk gate no longer asks whether a person approved. It asks whether the
  // verification this risk tier demands actually happened and passed.
  const tier = input.tierVerification
  const tierUnavailable = tier?.unavailable ?? []
  const tierFailed = tier?.failed ?? []
  const tierOk = tier === undefined ? true : tier.ok

  const riskGate: 'success' | 'failure' =
    input.isFork || weakened.length > 0 || !tierOk ? 'failure' : 'success'

  if (reviewGate === 'failure') reasons.push(...aggregate.reasons)
  if (input.isFork) reasons.push('pull request originates from a fork')
  if (weakened.length > 0) {
    reasons.push(
      `${weakened.length} control-plane protection(s) would be weakened: ${weakened
        .map((finding) => finding.description)
        .join('; ')}`,
    )
  }
  if (tierFailed.length > 0) {
    reasons.push(`\`${input.risk}\` tier verification failed: ${tierFailed.join(', ')}`)
  }
  if (tierUnavailable.length > 0) {
    reasons.push(
      `\`${input.risk}\` tier verification could not run: ${tierUnavailable.join(', ')}. An unrunnable check is not a passing one.`,
    )
  }

  const outcome = (decision: GateDecision, shouldDispatchFix = false): GateOutcome => ({
    decision,
    reasons,
    riskGate,
    reviewGate,
    shouldDispatchFix,
    review,
  })

  if (input.isDraft) {
    reasons.unshift('pull request is a draft')
    return outcome('waiting')
  }

  // --- Stops that no amount of green can override -------------------------

  if (input.humanHold === true) {
    reasons.unshift(`a person applied \`${HUMAN_HOLD_LABEL}\``)
    return outcome('human_approval_required')
  }

  if (input.isFork) {
    // Fork code has never been trusted here and still is not: running the
    // repository's own verification against it is exactly the thing that
    // hands a stranger the credentials.
    reasons.unshift('fork pull requests are never merged automatically')
    return outcome('human_approval_required')
  }

  if (weakened.length > 0 && input.humanApprovals === 0) {
    // The one case where autonomy genuinely cannot decide: the change makes the
    // rules that govern autonomy weaker. Letting the loop approve that is
    // letting it approve its own future approvals.
    reasons.unshift('this change weakens the loop’s own protections')
    return outcome('human_approval_required')
  }

  if (aggregate.status === 'blocked') {
    reasons.unshift('independent review could not reach a usable verdict')
    return outcome('blocked')
  }

  const retriesExhausted = input.reviewAttempts >= input.maxReviewAttempts
  const needsWork = reviewGate === 'failure' || failing.length > 0 || tierFailed.length > 0

  if (needsWork && retriesExhausted) {
    reasons.unshift(
      `retry limit reached: ${input.reviewAttempts} of ${input.maxReviewAttempts} review attempts used`,
    )
    return outcome('blocked')
  }

  if (tierUnavailable.length > 0) {
    // Nothing the coding agent can do about a missing Docker daemon, so this is
    // a block rather than a fix round. The runner moves to other work.
    reasons.unshift('required verification could not be performed in this environment')
    return outcome('blocked')
  }

  // --- Things a fix round can address -------------------------------------

  if (failing.length > 0) {
    reasons.unshift(`required check(s) failing: ${failing.map((c) => c.name).join(', ')}`)
    return outcome('changes_requested', true)
  }

  if (tierFailed.length > 0) return outcome('changes_requested', true)
  if (reviewGate === 'failure') return outcome('changes_requested', true)

  if (pending.length > 0) {
    reasons.unshift(`required check(s) not yet reported: ${pending.map((c) => c.name).join(', ')}`)
    return outcome('waiting')
  }

  // --- Everything the tier demands has passed ------------------------------

  reasons.unshift(
    `all required checks passed, \`${input.risk}\` tier verification succeeded, and ${
      aggregate.received === 1
        ? 'the independent review approved'
        : `all ${aggregate.received} independent reviews approved`
    }`,
  )
  return outcome('auto_merge')
}
