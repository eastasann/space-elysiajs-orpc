import { describe, expect, it } from 'bun:test'
import { selectNextIssue } from '../src/eligibility.ts'
import { type CheckState, decideMerge, type GateInput } from '../src/merge-gate.ts'
import { reviewersForRisk } from '../src/policy.ts'
import type { Finding, ReviewResult } from '../src/review.ts'
import { classifyRisk } from '../src/risk.ts'
import { approvingReview, diffOf, realPolicy } from './support/fixtures.ts'

const policy = realPolicy()

const REQUIRED_CHECKS = ['Lint and types', 'Tests', 'Build', 'End-to-end']

function allPassing(): CheckState[] {
  return REQUIRED_CHECKS.map((name) => ({ name, conclusion: 'success' as const }))
}

function gate(overrides: Partial<GateInput> = {}) {
  const risk = overrides.risk ?? 'low'
  const input: GateInput = {
    risk,
    // One review by default; the high-risk tier asks for two, and every test
    // that exercises it says so explicitly.
    reviews: [approvingReview()],
    requiredReviewers: reviewersForRisk(policy, risk),
    checks: allPassing(),
    requiredChecks: REQUIRED_CHECKS,
    reviewAttempts: 0,
    maxReviewAttempts: policy.retry.maxReviewAttempts,
    humanApprovals: 0,
    isFork: false,
    isDraft: false,
    blockingSeverity: policy.review.blockingSeverity,
    ...overrides,
  }
  return decideMerge(input)
}

/** The two independent approvals the high-risk tier requires. */
function dualApproval(): ReviewResult[] {
  return [approvingReview(), approvingReview()]
}

/**
 * The scenarios the loop is specified against. Each asserts the decision, both
 * gate check conclusions, and whether the fix loop is asked to run — the three
 * observable effects the workflows act on.
 */

describe('Scenario A: low risk, CI green, review approves', () => {
  const outcome = gate({ risk: 'low' })

  it('is eligible for automatic merge', () => {
    expect(outcome.decision).toBe('auto_merge')
  })

  it('passes both loop gates', () => {
    expect(outcome.riskGate).toBe('success')
    expect(outcome.reviewGate).toBe('success')
  })

  it('does not ask the coding agent for a fix', () => {
    expect(outcome.shouldDispatchFix).toBe(false)
  })

  it('also merges at medium risk', () => {
    expect(gate({ risk: 'medium' }).decision).toBe('auto_merge')
  })
})

describe('Scenario B: low risk, review requests changes', () => {
  const review: ReviewResult = {
    status: 'request_changes',
    summary: 'Acceptance criterion 3 is not met.',
    findings: [
      {
        severity: 'medium',
        file: 'apps/api/src/x.ts',
        line: null,
        description: 'missing pagination bound',
        suggested_action: 'bound the page size',
        source: 'agent',
        category: 'review',
      },
    ],
  }
  const outcome = gate({ risk: 'low', reviews: [review] })

  it('does not merge', () => {
    expect(outcome.decision).toBe('changes_requested')
    expect(outcome.decision).not.toBe('auto_merge')
  })

  it('fails the review gate so GitHub blocks the merge', () => {
    expect(outcome.reviewGate).toBe('failure')
  })

  it('triggers the fix loop', () => {
    expect(outcome.shouldDispatchFix).toBe(true)
  })

  it('is also reached by a blocking deterministic finding alone', () => {
    const secret: Finding = {
      severity: 'critical',
      file: null,
      line: null,
      description: 'possible credential',
      suggested_action: 'remove it',
      source: 'check:secrets',
      category: 'security',
    }

    const withSecret = gate({ reviews: [approvingReview({ findings: [secret] })] })
    expect(withSecret.decision).toBe('changes_requested')
    expect(withSecret.reviewGate).toBe('failure')
  })
})

describe('Scenario C: high risk with everything else passing', () => {
  // The philosophy change. Risk decides how much verification is demanded, not
  // whether a person is summoned. Two independent reviews and the high tier's
  // verification are the price; a human's attention is not.
  const outcome = gate({
    risk: 'high',
    reviews: dualApproval(),
    tierVerification: { ok: true, unavailable: [], failed: [] },
  })

  it('merges automatically once the high tier is satisfied', () => {
    expect(outcome.decision).toBe('auto_merge')
  })

  it('passes both loop gates', () => {
    expect(outcome.riskGate).toBe('success')
    expect(outcome.reviewGate).toBe('success')
  })

  it('needed no human approval to get there', () => {
    expect(outcome.decision).not.toBe('human_approval_required')
    expect(outcome.reasons.join(' ')).not.toContain('human')
  })

  it('refuses when only one of the two required reviews arrived', () => {
    // One approval out of two required is a missing opinion, not a favourable
    // one. This is the whole reason dual review is worth anything.
    const short = gate({ risk: 'high', reviews: [approvingReview()] })

    expect(short.decision).toBe('blocked')
    expect(short.reviewGate).toBe('failure')
    expect(short.reasons.join(' ')).toContain('1 of 2')
  })

  it('refuses when the high tier could not run its verification', () => {
    const unavailable = gate({
      risk: 'high',
      reviews: dualApproval(),
      tierVerification: { ok: false, unavailable: ['docker-smoke'], failed: [] },
    })

    expect(unavailable.decision).toBe('blocked')
    expect(unavailable.riskGate).toBe('failure')
    expect(unavailable.reasons.join(' ')).toContain('not a passing one')
  })

  it('asks for a fix when the high tier ran and failed', () => {
    const failed = gate({
      risk: 'high',
      reviews: dualApproval(),
      tierVerification: { ok: false, unavailable: [], failed: ['e2e'] },
    })

    expect(failed.decision).toBe('changes_requested')
    expect(failed.shouldDispatchFix).toBe(true)
  })
})

describe('Scenario D: CI fails', () => {
  const checks = allPassing().map((check) =>
    check.name === 'Tests' ? { ...check, conclusion: 'failure' as const } : check,
  )
  const outcome = gate({ checks })

  it('does not merge', () => {
    expect(outcome.decision).toBe('changes_requested')
    expect(outcome.decision).not.toBe('auto_merge')
  })

  it('names the failing check', () => {
    expect(outcome.reasons.join(' ')).toContain('Tests')
  })

  it('triggers the fix loop', () => {
    expect(outcome.shouldDispatchFix).toBe(true)
  })

  it.each([['timed_out'], ['cancelled']] as const)('treats %s as failure', (conclusion) => {
    const withConclusion = gate({
      checks: allPassing().map((check) =>
        check.name === 'Build' ? { ...check, conclusion } : check,
      ),
    })

    expect(withConclusion.decision).toBe('changes_requested')
  })

  it('treats a check that never reported as pending, never as passing', () => {
    const missing = gate({ checks: allPassing().filter((check) => check.name !== 'End-to-end') })

    expect(missing.decision).toBe('waiting')
    expect(missing.decision).not.toBe('auto_merge')
  })
})

describe('Scenario E: retry limit exceeded', () => {
  const review: ReviewResult = {
    status: 'request_changes',
    summary: 'Still not right.',
    findings: [],
  }
  const outcome = gate({ reviews: [review], reviewAttempts: policy.retry.maxReviewAttempts })

  it('stops the automation', () => {
    expect(outcome.decision).toBe('blocked')
  })

  it('reports the retry limit as the reason', () => {
    expect(outcome.reasons[0]).toContain('retry limit reached')
  })

  it('does not dispatch another fix', () => {
    expect(outcome.shouldDispatchFix).toBe(false)
  })

  it('keeps retrying while attempts remain', () => {
    const remaining = gate({
      reviews: [review],
      reviewAttempts: policy.retry.maxReviewAttempts - 1,
    })

    expect(remaining.decision).toBe('changes_requested')
    expect(remaining.shouldDispatchFix).toBe(true)
  })

  it('does not block a healthy pull request that happens to have used retries', () => {
    const recovered = gate({ reviewAttempts: policy.retry.maxReviewAttempts })

    expect(recovered.decision).toBe('auto_merge')
  })
})

describe('Scenario F: issue dependencies incomplete', () => {
  const issues = [
    {
      number: 4,
      title: 'sources table',
      state: 'open' as const,
      labels: ['agent:ready'],
      body: null,
    },
    {
      number: 5,
      title: 'sources service',
      state: 'open' as const,
      labels: ['agent:ready'],
      body: 'Depends on:\n\n- #4\n',
    },
  ]

  it('does not select an issue whose dependency is open', () => {
    const result = selectNextIssue(issues)

    expect(result.selected?.number).toBe(4)
  })

  it('reports the unmet dependency', () => {
    const blocked = selectNextIssue(issues).candidates.find((c) => c.issue.number === 5)

    expect(blocked?.eligible).toBe(false)
    expect(blocked?.reasons.join(' ')).toContain('#4')
  })

  it('selects the dependent issue once its dependency closes', () => {
    const closed = issues.map((issue) =>
      issue.number === 4 ? { ...issue, state: 'closed' as const } : issue,
    )

    expect(selectNextIssue(closed).selected?.number).toBe(5)
  })

  it('selects nothing when every ready issue is blocked', () => {
    const onlyBlocked = [issues[1] as (typeof issues)[number]]
    const result = selectNextIssue(onlyBlocked)

    expect(result.selected).toBeNull()
    expect(result.stopReason).toContain('unmet dependencies')
  })
})

describe('Other refusals to merge', () => {
  it('never auto-merges a fork pull request', () => {
    const outcome = gate({ isFork: true })

    expect(outcome.decision).toBe('human_approval_required')
    expect(outcome.riskGate).toBe('failure')
    expect(outcome.shouldDispatchFix).toBe(false)
  })

  it('waits on a draft', () => {
    expect(gate({ isDraft: true }).decision).toBe('waiting')
  })

  it('blocks when the review agent is unavailable or unusable', () => {
    const blocked = gate({
      reviews: [{ status: 'blocked', findings: [], summary: 'Review agent is not configured.' }],
    })

    expect(blocked.decision).toBe('blocked')
    expect(blocked.reviewGate).toBe('failure')
  })

  it('holds for a person when one applies the hold label', () => {
    const held = gate({ humanHold: true })

    expect(held.decision).toBe('human_approval_required')
    expect(held.reasons.join(' ')).toContain('needs:human')
  })

  it('holds for a person when the change weakens the loop’s own protections', () => {
    const weakening = gate({
      risk: 'high',
      reviews: dualApproval(),
      weakenedProtections: [
        {
          severity: 'critical',
          file: '.github/loop-policy.json',
          line: null,
          description: 'Required check `Tests` was removed from the policy.',
          suggested_action: 'Restore it.',
          source: 'control-plane',
          category: 'policy',
        },
      ],
    })

    expect(weakening.decision).toBe('human_approval_required')
    expect(weakening.riskGate).toBe('failure')
  })

  it('cannot be talked into merging by an approving review alone', () => {
    // Review approval is necessary but never sufficient: the deterministic
    // gates still have to pass.
    const outcome = gate({
      risk: 'high',
      checks: allPassing().map((c) =>
        c.name === 'Tests' ? { ...c, conclusion: 'failure' as const } : c,
      ),
    })

    expect(outcome.decision).not.toBe('auto_merge')
  })
})

describe('Risk classification feeding the gate', () => {
  it('sends a workflow change to the strongest tier, and still merges it', () => {
    const risk = classifyRisk({
      diff: diffOf([{ path: '.github/workflows/loop-pr.yml', added: ['  x: 1'] }]),
      labels: ['risk:low'],
      policy,
    })

    expect(risk.risk).toBe('high')
    expect(risk.controlPlane?.affected).toBe(true)

    // High, dual-reviewed, fully verified — and merged, with no human involved.
    const outcome = gate({
      risk: risk.risk,
      reviews: dualApproval(),
      tierVerification: { ok: true, unavailable: [], failed: [] },
    })
    expect(outcome.decision).toBe('auto_merge')
  })

  it('lets an ordinary feature change merge end to end', () => {
    const risk = classifyRisk({
      diff: diffOf([
        { path: 'apps/api/src/modules/sources/service.ts', added: ['const x = 1'] },
        { path: 'apps/api/test/sources.test.ts', added: ["it('x', () => {})"] },
      ]),
      labels: ['agent:ready'],
      policy,
    })

    expect(risk.risk).toBe('medium')
    expect(gate({ risk: risk.risk }).decision).toBe('auto_merge')
  })
})

describe('Self-referential required checks', () => {
  it('ignores the gate checks it publishes itself', () => {
    // Listing these in LOOP_REQUIRED_CHECKS would otherwise deadlock the gate:
    // it would wait for a check it is about to write.
    const outcome = gate({
      requiredChecks: [...REQUIRED_CHECKS, 'loop/risk-gate', 'loop/review-gate'],
    })

    expect(outcome.decision).toBe('auto_merge')
  })

  it('still honours the genuine required checks alongside them', () => {
    const outcome = gate({
      requiredChecks: [...REQUIRED_CHECKS, 'loop/review-gate'],
      checks: allPassing().filter((check) => check.name !== 'Build'),
    })

    expect(outcome.decision).toBe('waiting')
    expect(outcome.reasons.join(' ')).toContain('Build')
  })
})
