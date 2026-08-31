import type { PullRequestDiff } from '../diff.ts'
import type { Finding } from '../review.ts'
import { isCodeFile } from './paths.ts'

/**
 * Leftovers from writing the change rather than parts of it.
 *
 * `describe.skipIf` is deliberately not matched: this repository uses it to
 * skip integration suites when their service URLs are unset, which is intended
 * behaviour, not an abandoned test.
 */
const ARTIFACTS: Array<{ name: string; pattern: RegExp; severity: 'high' | 'medium' }> = [
  { name: 'debugger statement', pattern: /(^|[^\w.])debugger\s*;?\s*$/, severity: 'high' },
  {
    name: 'focused test',
    pattern: /\b(?:describe|it|test)\.only\s*\(/,
    severity: 'high',
  },
  {
    name: 'unconditionally skipped test',
    pattern: /\b(?:describe|it|test)\.skip\s*\(/,
    severity: 'medium',
  },
  { name: 'commented-out FIXME', pattern: /\/\/\s*FIXME\b/, severity: 'medium' },
]

/** Debug and dead-code artefacts among the lines a pull request adds. */
export function checkDebugArtifacts(diff: PullRequestDiff): Finding[] {
  const findings: Finding[] = []

  for (const file of diff.files) {
    if (!isCodeFile(file.path)) continue

    for (const { name, pattern, severity } of ARTIFACTS) {
      if (!file.addedLines.some((line) => pattern.test(line))) continue

      findings.push({
        severity,
        file: file.path,
        line: null,
        description: `${name} added in ${file.path}.`,
        suggested_action: 'Remove it before merging.',
        source: 'check:debug-artifacts',
        category: 'hygiene',
      })
    }
  }

  return findings
}
