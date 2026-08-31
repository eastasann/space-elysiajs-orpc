import { describe, expect, it } from 'bun:test'
import { PolicyError, parsePolicy, stepsForRisk } from '../src/policy.ts'
import { realPolicy } from './support/fixtures.ts'

describe('the shipped policy', () => {
  it('is valid', () => {
    expect(() => realPolicy()).not.toThrow()
  })

  it('protects the paths the loop itself depends on', () => {
    const policy = realPolicy()
    const highPatterns = policy.risk.paths
      .filter((rule) => rule.risk === 'high')
      .flatMap((rule) => rule.patterns)

    for (const guarded of ['.github/**', 'tooling/loop/**', 'packages/auth/**']) {
      expect(highPatterns).toContain(guarded)
    }
  })

  it('reaches AGENTS.md through the control plane rather than the path list', () => {
    // Deliberately not a high-risk path. Correcting a stale command in
    // AGENTS.md is documentation; changing what it says an agent may merge is
    // policy. `controlPlane.policySignals` tells them apart by the lines the
    // diff touches, so the two do not have to share a classification.
    const policy = realPolicy()
    const highPatterns = policy.risk.paths
      .filter((rule) => rule.risk === 'high')
      .flatMap((rule) => rule.patterns)

    expect(highPatterns).not.toContain('AGENTS.md')
    expect(policy.controlPlane.policySignals.length).toBeGreaterThan(0)
  })

  it('demands two independent reviews at high risk and fewer below', () => {
    const policy = realPolicy()

    expect(policy.tiers.high.reviewers).toBe(2)
    expect(policy.tiers.medium.reviewers).toBe(1)
    expect(policy.tiers.low.reviewers).toBe(1)
  })

  it('makes each tier strictly cumulative', () => {
    const policy = realPolicy()
    const names = (risk: 'low' | 'medium' | 'high') =>
      stepsForRisk(policy, risk).map((step) => step.name)

    expect(names('medium')).toEqual(expect.arrayContaining(names('low')))
    expect(names('high')).toEqual(expect.arrayContaining(names('medium')))
    expect(names('high').length).toBeGreaterThan(names('low').length)
  })

  it('does not classify the whole repository as high risk', () => {
    const policy = realPolicy()
    const highPatterns = policy.risk.paths
      .filter((rule) => rule.risk === 'high')
      .flatMap((rule) => rule.patterns)

    expect(highPatterns).not.toContain('**')
    expect(highPatterns).not.toContain('**/*')
  })

  it('allows a bounded number of review attempts', () => {
    expect(realPolicy().retry.maxReviewAttempts).toBeGreaterThan(0)
    expect(realPolicy().retry.maxReviewAttempts).toBeLessThanOrEqual(10)
  })
})

describe('parsePolicy', () => {
  it('rejects an unknown risk level', () => {
    const broken = {
      retry: { maxReviewAttempts: 3 },
      risk: {
        default: 'nuclear',
        paths: [{ risk: 'low', reason: 'x', patterns: ['a'] }],
        escalations: {
          maxChangedFiles: 1,
          maxDeletedLines: 1,
          destructiveMigrationGlobs: [],
          publicContractGlobs: [],
        },
      },
      review: { blockingSeverity: 'high' },
    }

    expect(() => parsePolicy(broken)).toThrow(PolicyError)
  })

  it('names every failing field', () => {
    let message = ''
    try {
      parsePolicy({ retry: {}, risk: {}, review: {} })
    } catch (error) {
      message = (error as Error).message
    }

    expect(message).toContain('retry.maxReviewAttempts')
    expect(message).toContain('risk.default')
  })

  it('ignores $comment keys used for inline rationale', () => {
    const policy = parsePolicy({
      $comment: ['note'],
      retry: { maxReviewAttempts: 2 },
      risk: {
        $comment: 'note',
        default: 'low',
        paths: [{ risk: 'high', reason: 'x', patterns: ['a'] }],
        escalations: {
          maxChangedFiles: 5,
          maxDeletedLines: 5,
          destructiveMigrationGlobs: [],
          publicContractGlobs: [],
        },
      },
      tiers: {
        low: { reviewers: 1, steps: [] },
        medium: { inherits: 'low', reviewers: 1, steps: [] },
        high: { inherits: 'medium', reviewers: 2, steps: [] },
      },
      controlPlane: { patterns: ['.github/**'], policySignals: [], alwaysPolicy: [] },
      review: { blockingSeverity: 'high' },
    })

    expect(policy.retry.maxReviewAttempts).toBe(2)
  })
})
