import { describe, expect, it } from 'bun:test'
import { initialState, parseLoopState, recordRound, serialiseLoopState } from '../src/state.ts'

const NOW = '2026-08-30T15:00:00.000Z'

describe('loop state round trip', () => {
  it('survives serialisation', () => {
    const state = recordRound({
      state: initialState(42),
      headSha: 'abc123',
      reviewStatus: 'request_changes',
      decision: 'changes_requested',
      at: NOW,
    })

    expect(parseLoopState(serialiseLoopState(state), 42)).toEqual(state)
  })

  it('is recoverable from a comment that has other prose around it', () => {
    const state = initialState(7)
    const comment = `### Autonomous loop\n\nsome table\n\n${serialiseLoopState(state)}\n\nmore text`

    expect(parseLoopState(comment, 7).issue).toBe(7)
  })
})

describe('parseLoopState', () => {
  it.each([
    ['a missing comment', null],
    ['an empty comment', ''],
    ['a comment with no state block', '### Autonomous loop\n\nnothing here'],
    ['a corrupt JSON block', '<!-- newsdeck-loop-state -->\n\n```json\n{not json\n```'],
    [
      'a state block of the wrong shape',
      '<!-- newsdeck-loop-state -->\n\n```json\n{"version":9}\n```',
    ],
  ])('falls back to a fresh state for %s', (_label, body) => {
    expect(parseLoopState(body, 3)).toEqual(initialState(3))
  })

  it('does not carry a negative attempt count', () => {
    const forged =
      '<!-- newsdeck-loop-state -->\n\n```json\n{"version":1,"issue":1,"reviewAttempts":-5,"lastReviewStatus":null,"lastDecision":null,"history":[]}\n```'

    expect(parseLoopState(forged, 1).reviewAttempts).toBe(0)
  })
})

describe('recordRound', () => {
  it('consumes an attempt only when changes were requested', () => {
    const after = recordRound({
      state: initialState(1),
      headSha: 'a',
      reviewStatus: 'request_changes',
      decision: 'changes_requested',
      at: NOW,
    })

    expect(after.reviewAttempts).toBe(1)
  })

  it.each([['waiting'], ['auto_merge'], ['human_approval_required'], ['blocked']] as const)(
    'does not consume an attempt for %s',
    (decision) => {
      const after = recordRound({
        state: initialState(1),
        headSha: 'a',
        reviewStatus: 'approve',
        decision,
        at: NOW,
      })

      expect(after.reviewAttempts).toBe(0)
    },
  )

  it('accumulates across rounds', () => {
    let state = initialState(1)
    for (let round = 0; round < 3; round += 1) {
      state = recordRound({
        state,
        headSha: `sha-${round}`,
        reviewStatus: 'request_changes',
        decision: 'changes_requested',
        at: NOW,
      })
    }

    expect(state.reviewAttempts).toBe(3)
    expect(state.history).toHaveLength(3)
  })

  it('bounds history so the comment cannot grow without limit', () => {
    let state = initialState(1)
    for (let round = 0; round < 40; round += 1) {
      state = recordRound({
        state,
        headSha: `sha-${round}`,
        reviewStatus: 'approve',
        decision: 'waiting',
        at: NOW,
      })
    }

    expect(state.history).toHaveLength(25)
  })
})
