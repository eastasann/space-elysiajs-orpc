import type { PullRequestDiff } from '../diff.ts'
import { matchesAnyGlob } from '../glob.ts'
import type { Finding } from '../review.ts'

const SOURCE_GLOBS = ['apps/*/src/**', 'packages/*/src/**', 'tooling/*/src/**']
const TEST_GLOBS = ['**/test/**', '**/*.test.ts', '**/*.test.tsx', 'e2e/**']

const NON_BEHAVIOURAL = /\.(css|json|md|txt|svg|png|jpg|ico)$/

/**
 * Source changed without any test changing with it.
 *
 * A heuristic, and reported as such: a pure rename or a comment edit legitimately
 * needs no test. It is a `medium` finding so it is visible to a reviewer without
 * blocking an automatic merge on its own.
 */
export function checkTestCoverage(diff: PullRequestDiff): Finding[] {
  const changedSource = diff.files.filter(
    (file) =>
      matchesAnyGlob(SOURCE_GLOBS, file.path) &&
      !NON_BEHAVIOURAL.test(file.path) &&
      file.addedLines.length > 0,
  )
  if (changedSource.length === 0) return []

  const changedTests = diff.files.filter((file) => matchesAnyGlob(TEST_GLOBS, file.path))
  if (changedTests.length > 0) return []

  return [
    {
      severity: 'medium',
      file: changedSource[0]?.path ?? null,
      line: null,
      description: `${changedSource.length} source file(s) changed but no test file changed.`,
      suggested_action:
        'Add or update a test that fails without this change, or say in the pull request why none is needed.',
      source: 'check:tests',
      category: 'testing',
    },
  ]
}
