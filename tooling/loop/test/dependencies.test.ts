import { describe, expect, it } from 'bun:test'
import { parseDependencyDeclaration, parseIssueDependencies } from '../src/dependencies.ts'

describe('parseIssueDependencies', () => {
  it('reads a bullet list under a heading', () => {
    const body = ['## Depends on', '', '- #12', '- #13', '', '## Goal', '', 'Something.'].join('\n')

    expect(parseIssueDependencies(body)).toEqual([12, 13])
  })

  it('reads a single-line form', () => {
    expect(parseIssueDependencies('Depends on: #12, #13')).toEqual([12, 13])
  })

  it('reads a plain line followed by a list', () => {
    expect(parseIssueDependencies('Depends on:\n- #4\n- #8\n')).toEqual([4, 8])
  })

  it('is case-insensitive', () => {
    expect(parseIssueDependencies('DEPENDS ON: #9')).toEqual([9])
  })

  it('tolerates trailing prose on a list item', () => {
    expect(parseIssueDependencies('Depends on:\n- #4 (the sources table)\n')).toEqual([4])
  })

  it('deduplicates and sorts', () => {
    expect(parseIssueDependencies('Depends on: #13, #12, #13')).toEqual([12, 13])
  })

  it.each([
    ['no dependency section', '## Goal\n\nCloses #99 eventually.'],
    ['an explicit none', 'Depends on: none'],
    ['an empty body', ''],
  ])('returns nothing for %s', (_label, body) => {
    expect(parseIssueDependencies(body)).toEqual([])
  })

  it('ignores issue references outside the block', () => {
    // The important property: prose mentioning an issue must not stall the loop.
    const body = [
      '## Context',
      '',
      'This follows on from #100 and relates to #101.',
      '',
      '## Depends on',
      '',
      '- #12',
      '',
      '## Out of Scope',
      '',
      '- Anything in #200',
    ].join('\n')

    expect(parseIssueDependencies(body)).toEqual([12])
  })

  it('handles a null body', () => {
    expect(parseIssueDependencies(null)).toEqual([])
  })
})

describe('parseDependencyDeclaration', () => {
  it('distinguishes an explicit none from an absent section', () => {
    expect(parseDependencyDeclaration('Depends on: none')).toEqual({
      declared: true,
      dependencies: [],
    })
    expect(parseDependencyDeclaration('## Goal\n\nSomething.')).toEqual({
      declared: false,
      dependencies: [],
    })
  })

  it('reports a declared list', () => {
    expect(parseDependencyDeclaration('Depends on: #4, #8')).toEqual({
      declared: true,
      dependencies: [4, 8],
    })
  })

  it('treats a prose-only block as undeclared, not as none', () => {
    // The real failure this guards: `Depends on **[M1.03] ...**.` names a
    // milestone title, not an issue. Reading it as "checked, nothing blocks
    // this" is exactly the meaning `Depends on: none` is reserved for, and it
    // silently discarded the loop's dependency ordering (issue #48).
    const body = [
      '## Context',
      '',
      'Depends on **[M1.03] Expose sources through the oRPC contract**.',
      '',
      'More prose here.',
    ].join('\n')

    expect(parseDependencyDeclaration(body)).toEqual({
      declared: false,
      dependencies: [],
    })
  })

  it('treats a block with no parsable reference and no "none" as undeclared', () => {
    expect(parseDependencyDeclaration('Depends on: the sources milestone')).toEqual({
      declared: false,
      dependencies: [],
    })
  })
})
