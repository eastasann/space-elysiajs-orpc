import { describe, expect, it } from 'bun:test'
import type { Finding } from '../src/review.ts'
import {
  blockingFindings,
  mergeReview,
  parseReviewResult,
  parseReviewText,
  sanitiseForMarkdown,
} from '../src/review.ts'

const VALID = {
  status: 'approve',
  findings: [],
  summary: 'Meets every acceptance criterion.',
}

describe('parseReviewResult', () => {
  it('accepts a well-formed result', () => {
    const outcome = parseReviewResult(VALID)

    expect(outcome.ok).toBe(true)
    expect(outcome.result.status).toBe('approve')
  })

  it('applies defaults for optional finding metadata', () => {
    const outcome = parseReviewResult({
      status: 'request_changes',
      summary: 'One issue.',
      findings: [{ severity: 'medium', description: 'x', suggested_action: 'y' }],
    })

    expect(outcome.result.findings[0]).toMatchObject({ source: 'agent', category: 'review' })
  })

  it.each([
    ['an unknown status', { ...VALID, status: 'looks_fine' }],
    ['a missing summary', { status: 'approve', findings: [] }],
    ['findings that are not an array', { ...VALID, findings: 'none' }],
    [
      'an unknown severity',
      { ...VALID, findings: [{ severity: 'spicy', description: 'a', suggested_action: 'b' }] },
    ],
    ['a non-object', 'approve'],
    ['null', null],
  ])('treats %s as blocked rather than approved', (_label, raw) => {
    const outcome = parseReviewResult(raw)

    expect(outcome.ok).toBe(false)
    expect(outcome.result.status).toBe('blocked')
  })

  it('never yields approve from invalid input', () => {
    // The property that matters: an agent cannot approve by emitting garbage.
    for (const raw of [undefined, {}, [], 42, { status: 'approve' }]) {
      expect(parseReviewResult(raw).result.status).not.toBe('approve')
    }
  })

  it('rejects an oversized findings list', () => {
    const findings = Array.from({ length: 201 }, () => ({
      severity: 'low',
      description: 'x',
      suggested_action: 'y',
    }))

    expect(parseReviewResult({ ...VALID, findings }).result.status).toBe('blocked')
  })

  it('strips control characters from agent text', () => {
    const hostile = `ok${String.fromCharCode(0x07)}${String.fromCharCode(0x1b)} done`

    expect(parseReviewResult({ ...VALID, summary: hostile }).result.summary).toBe('ok done')
  })
})

describe('parseReviewText', () => {
  it('reads a fenced JSON block', () => {
    const outcome = parseReviewText(
      ['Here is my review:', '', '```json', JSON.stringify(VALID), '```', ''].join('\n'),
    )

    expect(outcome.ok).toBe(true)
    expect(outcome.result.status).toBe('approve')
  })

  it('reads bare JSON', () => {
    expect(parseReviewText(JSON.stringify(VALID)).result.status).toBe('approve')
  })

  it('blocks on prose with no JSON at all', () => {
    const outcome = parseReviewText('Looks good to me, ship it!')

    expect(outcome.ok).toBe(false)
    expect(outcome.result.status).toBe('blocked')
  })
})

describe('sanitiseForMarkdown', () => {
  it('defuses an attempt to forge loop state in a comment', () => {
    const hostile = 'x --> <!-- newsdeck-loop-state --> then more text'
    const safe = sanitiseForMarkdown(hostile)

    expect(safe).not.toContain('<!--')
    expect(safe).not.toContain('-->')
  })

  it('neutralises backticks so text cannot escape a code fence', () => {
    expect(sanitiseForMarkdown('a `b` c')).toBe("a 'b' c")
  })
})

describe('blockingFindings', () => {
  const findings: Finding[] = [
    { severity: 'low', description: 'a', suggested_action: 'a', source: 'x', category: 'y' },
    { severity: 'high', description: 'b', suggested_action: 'b', source: 'x', category: 'y' },
    { severity: 'critical', description: 'c', suggested_action: 'c', source: 'x', category: 'y' },
  ]

  it('selects findings at or above the threshold', () => {
    expect(blockingFindings(findings, 'high').map((f) => f.severity)).toEqual(['high', 'critical'])
  })

  it('selects nothing when the threshold is above every finding', () => {
    expect(blockingFindings([findings[0] as Finding], 'high')).toEqual([])
  })
})

describe('mergeReview', () => {
  const secret: Finding = {
    severity: 'critical',
    description: 'possible credential',
    suggested_action: 'remove it',
    source: 'check:secrets',
    category: 'security',
  }

  it('lets a deterministic finding override an agent approval', () => {
    const merged = mergeReview(
      { status: 'approve', findings: [], summary: 'fine' },
      [secret],
      'high',
    )

    expect(merged.status).toBe('request_changes')
    expect(merged.findings).toContain(secret)
  })

  it('keeps approve when nothing blocking was found', () => {
    const note: Finding = { ...secret, severity: 'low', source: 'check:tests' }

    expect(
      mergeReview({ status: 'approve', findings: [], summary: 'fine' }, [note], 'high').status,
    ).toBe('approve')
  })

  it('keeps blocked as blocked', () => {
    expect(mergeReview({ status: 'blocked', findings: [], summary: 'x' }, [], 'high').status).toBe(
      'blocked',
    )
  })

  it('keeps request_changes even with no deterministic findings', () => {
    expect(
      mergeReview({ status: 'request_changes', findings: [], summary: 'x' }, [], 'high').status,
    ).toBe('request_changes')
  })
})
