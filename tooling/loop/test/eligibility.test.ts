import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import {
  DEFAULT_SELECTION_POLICY,
  evaluateCandidates,
  type IssueSummary,
  selectNextIssue,
} from '../src/eligibility.ts'

function issue(overrides: Partial<IssueSummary> & { number: number }): IssueSummary {
  return {
    title: `issue ${overrides.number}`,
    state: 'open',
    labels: ['agent:ready'],
    body: null,
    ...overrides,
  }
}

describe('selectNextIssue', () => {
  it('picks the lowest-numbered eligible issue', () => {
    const result = selectNextIssue([issue({ number: 9 }), issue({ number: 4 })])

    expect(result.selected?.number).toBe(4)
  })

  it('ignores issues without the ready label', () => {
    const result = selectNextIssue([issue({ number: 4, labels: [] }), issue({ number: 9 })])

    expect(result.selected?.number).toBe(9)
  })

  it.each([['agent:in-progress'], ['agent:review'], ['agent:blocked']])(
    'skips an issue carrying %s',
    (label) => {
      const result = selectNextIssue([
        issue({ number: 4, labels: ['agent:ready', label] }),
        issue({ number: 9 }),
      ])

      expect(result.selected?.number).toBe(9)
    },
  )

  it('ignores closed issues', () => {
    const result = selectNextIssue([issue({ number: 4, state: 'closed' }), issue({ number: 9 })])

    expect(result.selected?.number).toBe(9)
  })

  it('treats an unknown dependency as unsatisfied', () => {
    // Unverifiable must never mean satisfied.
    const result = selectNextIssue([issue({ number: 9, body: 'Depends on: #404' })])

    expect(result.selected).toBeNull()
    expect(result.candidates[0]?.dependencies[0]).toMatchObject({ number: 404, satisfied: false })
  })

  it('explains why nothing was selected', () => {
    expect(selectNextIssue([]).stopReason).toBe('no open issues')
    expect(selectNextIssue([issue({ number: 1, labels: [] })]).stopReason).toContain('agent:ready')
    expect(
      selectNextIssue([issue({ number: 1, labels: ['agent:ready', 'agent:blocked'] })]).stopReason,
    ).toContain('blocked')
  })
})

describe('evaluateCandidates', () => {
  it('reports the reasoning for every open issue, not only the winner', () => {
    const candidates = evaluateCandidates([
      issue({ number: 1, labels: [] }),
      issue({ number: 2 }),
      issue({ number: 3, state: 'closed' }),
    ])

    expect(candidates.map((candidate) => candidate.issue.number)).toEqual([1, 2])
    expect(candidates[0]?.eligible).toBe(false)
    expect(candidates[1]?.eligible).toBe(true)
  })

  it('excludes closed issues from the candidate list', () => {
    const candidates = evaluateCandidates([
      issue({ number: 4, state: 'closed' }),
      issue({ number: 5, body: 'Depends on: #4' }),
    ])

    expect(candidates.map((candidate) => candidate.issue.number)).toEqual([5])
  })

  it('marks a satisfied dependency as satisfied', () => {
    const candidates = evaluateCandidates([
      issue({ number: 4, state: 'closed' }),
      issue({ number: 5, body: 'Depends on: #4' }),
    ])
    const dependent = candidates.find((candidate) => candidate.issue.number === 5)

    expect(dependent?.dependencies[0]).toMatchObject({ number: 4, satisfied: true })
    expect(dependent?.eligible).toBe(true)
  })
})

describe('fallback dependency map', () => {
  const policy = {
    ...DEFAULT_SELECTION_POLICY,
    fallbackDependencies: { 5: [4], 9: [4, 8] },
  }

  it('applies to an issue whose body declares nothing', () => {
    const result = selectNextIssue([issue({ number: 4 }), issue({ number: 5 })], policy)

    expect(result.selected?.number).toBe(4)
    const dependent = result.candidates.find((candidate) => candidate.issue.number === 5)
    expect(dependent?.eligible).toBe(false)
    expect(dependent?.dependencies).toEqual([{ number: 4, satisfied: false, detail: '#4 is open' }])
  })

  it('is overridden by a body that declares its own', () => {
    // Adopting the convention on an issue retires its fallback entry.
    const result = selectNextIssue(
      [issue({ number: 4 }), issue({ number: 5, body: 'Depends on: none' })],
      policy,
    )
    const dependent = result.candidates.find((candidate) => candidate.issue.number === 5)

    expect(dependent?.dependencies).toEqual([])
    expect(dependent?.eligible).toBe(true)
  })

  it('does not invent dependencies for issues absent from the map', () => {
    const result = selectNextIssue([issue({ number: 30 })], policy)

    expect(result.selected?.number).toBe(30)
  })
})

describe('the shipped fallback map', () => {
  const map = JSON.parse(
    readFileSync(
      new URL('../../../.github/loop-dependencies.json', import.meta.url).pathname,
      'utf8',
    ),
  ) as { dependencies: Record<string, number[]> }

  it('never declares an issue as its own dependency', () => {
    for (const [number, dependencies] of Object.entries(map.dependencies)) {
      expect(dependencies).not.toContain(Number(number))
    }
  })

  it('only depends on lower-numbered issues, so the graph cannot cycle', () => {
    // The backlog was written in dependency order; enforcing it here means a
    // cycle can never wedge selection.
    for (const [number, dependencies] of Object.entries(map.dependencies)) {
      for (const dependency of dependencies) {
        expect(`#${number} -> #${dependency}`).toBeTruthy()
        expect(dependency).toBeLessThan(Number(number))
      }
    }
  })
})
