import { describe, expect, it } from 'bun:test'
import type { GateOutcome } from '../src/merge-gate.ts'
import type { Finding, ReviewResult } from '../src/review.ts'
import type { RiskAssessment } from '../src/risk.ts'
import { initialState } from '../src/state.ts'
import { renderPullRequestSummary } from '../src/summary.ts'

const RISK: RiskAssessment = {
  risk: 'medium',
  reasons: [{ risk: 'medium', source: 'default', detail: 'policy default' }],
}

const OUTCOME: GateOutcome = {
  decision: 'changes_requested',
  reasons: ['required check(s) failing: test'],
  riskGate: 'success',
  reviewGate: 'failure',
  shouldDispatchFix: true,
  review: { status: 'request_changes', findings: [], summary: 'needs work' },
}

const FINDING: Finding = {
  severity: 'high',
  file: 'apps/api/src/modules/dedup/service.ts',
  description: 'representative lookup misses the batch group union',
  suggested_action: 'query the union of candidates in the batch group',
  source: 'agent',
  category: 'correctness',
}

const REVIEW: ReviewResult = {
  status: 'request_changes',
  findings: [FINDING],
  summary: 'needs work',
}

describe('renderPullRequestSummary', () => {
  it('omits the recurring findings section when nothing recurred', () => {
    const summary = renderPullRequestSummary({
      issue: 12,
      risk: RISK,
      review: REVIEW,
      outcome: OUTCOME,
      state: initialState(12),
      maxReviewAttempts: 3,
      checks: [],
      recurrence: [],
    })

    expect(summary).not.toContain('Recurring findings')
  })

  it('tells a fix round which heads a recurring finding survived', () => {
    const summary = renderPullRequestSummary({
      issue: 12,
      risk: RISK,
      review: REVIEW,
      outcome: OUTCOME,
      state: initialState(12),
      maxReviewAttempts: 3,
      checks: [],
      recurrence: [
        {
          finding: FINDING,
          occurrences: [
            { attempt: 0, headSha: '13a70f8aaaaaaaaaaaaaaaa' },
            { attempt: 1, headSha: '241e8faaaaaaaaaaaaaaaaa' },
          ],
        },
      ],
    })

    expect(summary).toContain('Recurring findings')
    expect(summary).toContain('13a70f8aaaaa')
    expect(summary).toContain('241e8faaaaa')
    expect(summary).toContain('batch group union')
  })
})
