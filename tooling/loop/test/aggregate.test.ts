import { describe, expect, it } from 'bun:test'
import { aggregateReviews } from '../src/aggregate.ts'
import { checkTestIntegrity } from '../src/checks/test-integrity.ts'
import type { Finding, ReviewResult } from '../src/review.ts'
import { diffOf } from './support/fixtures.ts'

const finding = (overrides: Partial<Finding> = {}): Finding => ({
  severity: 'medium',
  file: 'apps/api/src/x.ts',
  line: 1,
  description: 'something',
  suggested_action: 'fix it',
  source: 'agent',
  category: 'review',
  ...overrides,
})

const review = (overrides: Partial<ReviewResult> = {}): ReviewResult => ({
  status: 'approve',
  findings: [],
  summary: 'Looks right.',
  ...overrides,
})

const aggregate = (reviews: ReviewResult[], required = 2) =>
  aggregateReviews({ reviews, required, blockingSeverity: 'high' })

describe('dual review aggregation', () => {
  it('approves when both reviewers approve', () => {
    const outcome = aggregate([review(), review()])

    expect(outcome.status).toBe('approve')
    expect(outcome.unanimous).toBe(true)
    expect(outcome.received).toBe(2)
  })

  it('approves when one attaches only informational findings', () => {
    const outcome = aggregate([
      review(),
      review({
        findings: [
          finding({ severity: 'info', description: 'a naming nit' }),
          finding({ severity: 'low', description: 'a comment could be clearer' }),
        ],
      }),
    ])

    expect(outcome.status).toBe('approve')
    expect(outcome.findings).toHaveLength(2)
  })

  it('requests changes when either reviewer does', () => {
    expect(aggregate([review(), review({ status: 'request_changes' })]).status).toBe(
      'request_changes',
    )
    expect(aggregate([review({ status: 'request_changes' }), review()]).status).toBe(
      'request_changes',
    )
  })

  it('requests changes on a blocking finding even from an approving reviewer', () => {
    // The reviewer said approve and then described a critical problem. The
    // finding wins: a contradiction is resolved in the strict direction.
    const outcome = aggregate([review(), review({ findings: [finding({ severity: 'critical' })] })])

    expect(outcome.status).toBe('request_changes')
    expect(outcome.reasons.join(' ')).toContain('at or above')
  })

  it('blocks when either reviewer is blocked', () => {
    expect(aggregate([review(), review({ status: 'blocked' })]).status).toBe('blocked')
  })

  it('blocks when fewer reviews arrive than the tier requires', () => {
    const outcome = aggregate([review()], 2)

    expect(outcome.status).toBe('blocked')
    expect(outcome.reasons.join(' ')).toContain('1 of 2')
  })

  it('blocks when no review arrives at all', () => {
    const outcome = aggregate([], 1)

    expect(outcome.status).toBe('blocked')
    expect(outcome.summary).toContain('No reviewer produced a usable result')
  })

  it('never turns a shortfall into an approval', () => {
    // The single property that makes dual review worth running.
    for (const reviews of [[], [review()], [review(), review({ status: 'blocked' })]]) {
      expect(aggregate(reviews, 2).status).not.toBe('approve')
    }
  })

  it('collapses a finding both reviewers raised, keeping the higher severity', () => {
    const outcome = aggregate([
      review({ findings: [finding({ severity: 'low', description: 'Same problem' })] }),
      review({ findings: [finding({ severity: 'medium', description: 'Same problem' })] }),
    ])

    expect(outcome.findings).toHaveLength(1)
    expect(outcome.findings[0]?.severity).toBe('medium')
  })

  it('names which reviewer said what', () => {
    const outcome = aggregate([review({ summary: 'First.' }), review({ summary: 'Second.' })])

    expect(outcome.summary).toContain('Reviewer A: First.')
    expect(outcome.summary).toContain('Reviewer B: Second.')
  })

  it('works unchanged for a single-reviewer tier', () => {
    expect(aggregate([review()], 1).status).toBe('approve')
    expect(aggregate([review({ status: 'request_changes' })], 1).status).toBe('request_changes')
  })
})

describe('test integrity', () => {
  it('flags a deleted test file', () => {
    const diff = diffOf([{ path: 'packages/ui/test/Panel.test.tsx' }])
    const file = diff.files[0]
    if (file === undefined) throw new Error('expected one file in the fixture')
    file.status = 'removed'

    const findings = checkTestIntegrity(diff)
    expect(findings[0]?.severity).toBe('high')
    expect(findings[0]?.description).toContain('deleted')
  })

  // These fixtures are assembled rather than written literally. A fixture
  // containing the marker it tests for is itself flagged by the very check it
  // covers, so every pull request touching this file would report a skipped or
  // focused test that does not exist.
  const marker = (modifier: string) => `  test${'.'}${modifier}('creates a source', () => {})`

  it('flags newly skipped tests', () => {
    const findings = checkTestIntegrity(
      diffOf([
        {
          path: 'apps/api/test/sources.test.ts',
          added: [marker('skip')],
          removed: ["  test('creates a source', () => {})"],
        },
      ]),
    )

    expect(findings.some((f) => f.description.includes('skipped'))).toBe(true)
  })

  it('flags a focus marker', () => {
    const findings = checkTestIntegrity(
      diffOf([{ path: 'apps/api/test/x.test.ts', added: [marker('only')] }]),
    )

    expect(findings.some((f) => f.description.includes('other test'))).toBe(true)
  })

  it('flags an assertion that cannot fail', () => {
    const findings = checkTestIntegrity(
      diffOf([{ path: 'apps/api/test/x.test.ts', added: ['    expect(true).toBe(true)'] }]),
    )

    expect(findings.some((f) => f.description.includes('cannot fail'))).toBe(true)
  })

  it('flags a file-wide type suppression', () => {
    const findings = checkTestIntegrity(
      diffOf([{ path: 'apps/api/src/x.ts', added: ['// @ts-nocheck'] }]),
    )

    expect(findings.some((f) => f.description.includes('@ts-nocheck'))).toBe(true)
  })

  it('flags a broad lint suppression', () => {
    const findings = checkTestIntegrity(
      diffOf([{ path: 'apps/api/src/x.ts', added: ['/* eslint-disable */'] }]),
    )

    expect(findings.some((f) => f.description.includes('file-wide `eslint-disable`'))).toBe(true)
  })

  it('notices a test file that loses far more than it gains', () => {
    const findings = checkTestIntegrity(
      diffOf([
        {
          path: 'apps/api/test/x.test.ts',
          added: ["it('one', () => {})"],
          removed: Array.from({ length: 40 }, (_, i) => `  expect(result[${i}]).toBe(${i})`),
        },
      ]),
    )

    expect(findings.some((f) => f.description.includes('net reduction in coverage'))).toBe(true)
  })

  it('says nothing about an ordinary test being added', () => {
    const findings = checkTestIntegrity(
      diffOf([
        {
          path: 'apps/api/test/x.test.ts',
          added: ["it('rejects an empty name', () => {", '  expect(result.ok).toBe(false)', '})'],
        },
      ]),
    )

    expect(findings).toEqual([])
  })

  it('does not flag removing a suppression', () => {
    const findings = checkTestIntegrity(
      diffOf([{ path: 'apps/api/src/x.ts', removed: ['// @ts-nocheck'] }]),
    )

    expect(findings).toEqual([])
  })

  // Assembled for the same reason as `marker` above: written literally, the
  // string would be flagged in every pull request that touches this file.
  const nocheck = `// @ts-${'nocheck'}`

  it('says nothing about prose that describes a suppression', () => {
    const findings = checkTestIntegrity(
      diffOf([{ path: '.claude/skills/loop-fix/SKILL.md', added: [`Never add ${nocheck}.`] }]),
    )

    expect(findings).toEqual([])
  })

  it('says nothing about a marker named in a fixture beside the tests', () => {
    const findings = checkTestIntegrity(
      diffOf([{ path: 'apps/api/test/fixtures/notes.md', added: [marker('only')] }]),
    )

    expect(findings).toEqual([])
  })

  it('does not call a deleted fixture a deleted test', () => {
    const diff = diffOf([{ path: 'apps/api/test/fixtures/sources.json' }])
    const file = diff.files[0]
    if (file === undefined) throw new Error('expected one file in the fixture')
    file.status = 'removed'

    expect(checkTestIntegrity(diff)).toEqual([])
  })

  it('does not flag a narrow, explained suppression', () => {
    const findings = checkTestIntegrity(
      diffOf([
        {
          path: 'apps/api/src/x.ts',
          added: ['// @ts-expect-error the upstream types are wrong here'],
        },
      ]),
    )

    expect(findings).toEqual([])
  })
})
