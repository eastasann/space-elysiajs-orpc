import { describe, expect, it } from 'bun:test'
import {
  detectRecurrence,
  findingsMatch,
  type HistoryFindingsEntry,
  toFindingRecord,
} from '../src/recurrence.ts'
import type { Finding } from '../src/review.ts'

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    severity: 'high',
    file: 'apps/api/src/modules/dedup/service.ts',
    description:
      'The database lookup for representative candidates only queries the ' +
      "representative's own canonicalUrl and contentHash, not the union of " +
      'those fields across every candidate folded into its batch group.',
    suggested_action: 'Query the union of fields across the whole batch group.',
    source: 'agent',
    category: 'correctness',
    ...overrides,
  }
}

const REWORDED =
  'Representative candidate lookups check only the representative row’s ' +
  'canonicalUrl and contentHash, missing the canonicalUrl and contentHash ' +
  'values carried by the other candidates merged into the same batch group.'

const UNRELATED =
  "The worker's retry backoff never resets after a successful job, so a " +
  'flaky job that succeeds once still waits at the maximum delay next time.'

describe('findingsMatch', () => {
  it('matches a finding against itself', () => {
    const record = toFindingRecord(finding())
    expect(findingsMatch(record, record)).toBe(true)
  })

  it('matches a reworded restatement of the same defect', () => {
    const original = toFindingRecord(finding())
    const reworded = toFindingRecord(finding({ description: REWORDED }))
    expect(findingsMatch(original, reworded)).toBe(true)
  })

  it('does not match an unrelated finding', () => {
    const original = toFindingRecord(finding())
    const unrelated = toFindingRecord(finding({ description: UNRELATED }))
    expect(findingsMatch(original, unrelated)).toBe(false)
  })

  it('does not match the same wording about a different file', () => {
    const a = toFindingRecord(finding({ file: 'apps/api/src/modules/dedup/service.ts' }))
    const b = toFindingRecord(finding({ file: 'apps/worker/src/handlers/dedup.ts' }))
    expect(findingsMatch(a, b)).toBe(false)
  })

  it('compares on wording alone when neither finding names a file', () => {
    const a = toFindingRecord(finding({ file: null }))
    const b = toFindingRecord(finding({ file: null, description: REWORDED }))
    expect(findingsMatch(a, b)).toBe(true)
  })
})

describe('detectRecurrence', () => {
  it('reports a finding that recurs across two attempts', () => {
    const history: HistoryFindingsEntry[] = [
      { headSha: '13a70f8', attempt: 0, findings: [toFindingRecord(finding())] },
      {
        headSha: '241e8fa',
        attempt: 1,
        findings: [toFindingRecord(finding({ description: REWORDED }))],
      },
    ]

    const current = [finding()]
    const recurring = detectRecurrence(current, history, '1da74e5')

    expect(recurring).toHaveLength(1)
    expect(recurring[0]?.occurrences.map((o) => o.headSha).sort()).toEqual(
      ['13a70f8', '241e8fa'].sort(),
    )
  })

  it('does not report a genuinely new finding as recurring', () => {
    const history: HistoryFindingsEntry[] = [
      { headSha: '13a70f8', attempt: 0, findings: [toFindingRecord(finding())] },
    ]

    const current = [finding(), finding({ description: UNRELATED, file: null })]
    const recurring = detectRecurrence(current, history, '241e8fa')

    expect(recurring).toHaveLength(1)
    expect(recurring[0]?.finding.description).toBe(finding().description)
  })

  it('does not treat a re-evaluation of the same head as a prior attempt', () => {
    const history: HistoryFindingsEntry[] = [
      { headSha: 'abc123', attempt: 0, findings: [toFindingRecord(finding())] },
    ]

    expect(detectRecurrence([finding()], history, 'abc123')).toEqual([])
  })

  it('ignores history entries with nothing retained', () => {
    const history: HistoryFindingsEntry[] = [{ headSha: 'abc123', attempt: 0, findings: [] }]

    expect(detectRecurrence([finding()], history, 'def456')).toEqual([])
  })
})
