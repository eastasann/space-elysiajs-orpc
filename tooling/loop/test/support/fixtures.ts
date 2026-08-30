import { readFileSync } from 'node:fs'
import type { PullRequestDiff } from '../../src/diff.ts'
import { type LoopPolicy, parsePolicy } from '../../src/policy.ts'
import type { ReviewResult } from '../../src/review.ts'

/** The policy this repository actually ships, so tests exercise the real rules. */
export function realPolicy(): LoopPolicy {
  const path = new URL('../../../../.github/loop-policy.json', import.meta.url).pathname
  return parsePolicy(JSON.parse(readFileSync(path, 'utf8')))
}

export function diffOf(
  files: ReadonlyArray<{
    path: string
    added?: string[]
    removed?: string[]
    status?: 'added' | 'modified' | 'removed' | 'renamed'
  }>,
): PullRequestDiff {
  return {
    files: files.map((file) => ({
      path: file.path,
      status: file.status ?? 'modified',
      addedLines: file.added ?? [],
      removedLines: file.removed ?? [],
    })),
  }
}

export function approvingReview(overrides: Partial<ReviewResult> = {}): ReviewResult {
  return { status: 'approve', findings: [], summary: 'Looks good.', ...overrides }
}
