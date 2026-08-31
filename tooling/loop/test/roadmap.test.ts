import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'

/**
 * docs/roadmap.md and .github/loop-dependencies.json state the same
 * dependency graph in two places for two different readers — a human
 * skimming the backlog, and the selector's fallback map (src/eligibility.ts).
 * Nothing previously checked that the two agree; this is that check. See
 * issue #48.
 */

const repoRoot = new URL('../../../', import.meta.url)

function parseRoadmapDependencies(markdown: string): Map<number, number[]> {
  const map = new Map<number, number[]>()

  for (const line of markdown.split('\n')) {
    const cells = line.split('|').map((cell) => cell.trim())
    // A markdown table row splits on `|` into an empty string at each end.
    if (cells.length !== 5 || cells[0] !== '' || cells[4] !== '') continue

    const issueMatch = /^\[#(\d+)\]/.exec(cells[1] as string)
    if (issueMatch === null) continue

    const number = Number(issueMatch[1])
    const dependencies = [...(cells[3] as string).matchAll(/#(\d+)/g)]
      .map((match) => Number(match[1]))
      .sort((a, b) => a - b)

    map.set(number, dependencies)
  }

  return map
}

describe('the roadmap table and the fallback dependency map', () => {
  const roadmap = parseRoadmapDependencies(
    readFileSync(new URL('docs/roadmap.md', repoRoot).pathname, 'utf8'),
  )
  const fallback = JSON.parse(
    readFileSync(new URL('.github/loop-dependencies.json', repoRoot).pathname, 'utf8'),
  ) as { dependencies: Record<string, number[]> }

  it('parses at least one dependency edge from the roadmap, so this test cannot pass vacuously', () => {
    const withDependencies = [...roadmap.values()].filter((deps) => deps.length > 0)
    expect(withDependencies.length).toBeGreaterThan(0)
  })

  it('gives every roadmap dependency the same edges the fallback map has', () => {
    for (const [number, dependencies] of roadmap) {
      if (dependencies.length === 0) continue
      expect(fallback.dependencies[number]).toEqual(dependencies)
    }
  })

  it('gives every fallback map entry the same edges the roadmap has', () => {
    for (const [number, dependencies] of Object.entries(fallback.dependencies)) {
      expect(roadmap.get(Number(number))).toEqual([...dependencies].sort((a, b) => a - b))
    }
  })
})
