import type { DiffFile, PullRequestDiff } from '../diff.ts'
import { matchesAnyGlob } from '../glob.ts'
import type { Finding } from '../review.ts'

/**
 * Tests weakened rather than satisfied.
 *
 * The failure mode this exists for is specific and, for an unattended loop,
 * close to inevitable: an agent is told to make the suite pass, the fastest
 * route is to delete the assertion, and nothing in a green build distinguishes
 * "fixed the bug" from "stopped looking for it". A human reviewer notices; a
 * loop that merges on green does not, unless something looks.
 *
 * These are deliberately blocking. A legitimate reason to remove a test exists,
 * but it belongs in the issue, and stating it there is cheap compared to
 * silently losing coverage.
 */

const TEST_GLOBS = ['**/test/**', '**/*.test.ts', '**/*.test.tsx', 'e2e/**']

/** Assertions so weak they cannot fail. `expect(true).toBe(true)` and friends. */
const VACUOUS_ASSERTION =
  /expect\(\s*(?:true|1|'[^']*'|"[^"]*"|\[\s*\]|\{\s*\})\s*\)\s*\.\s*(?:toBe|toEqual|toBeTruthy|toBeDefined)/

const SKIP_MARKER = /\b(?:describe|test|it)\s*\.\s*(?:skip|todo|failing)\b/
const ONLY_MARKER = /\b(?:describe|test|it)\s*\.\s*only\b/

/** Suppressions that switch off a whole file or rule rather than one line. */
const BROAD_SUPPRESSION = [
  { pattern: /@ts-nocheck/, detail: '`@ts-nocheck` disables type checking for an entire file.' },
  {
    pattern: /biome-ignore-all|biome-ignore\s+lint\s*:/,
    detail: 'A file-wide lint suppression hides every instance of the rule, not the one in hand.',
  },
  {
    pattern: /eslint-disable(?!-next-line)/,
    detail: 'A file-wide `eslint-disable` hides every instance of the rule.',
  },
]

/** `@ts-expect-error`/`@ts-expect-error` with no explanation after it. */
const BARE_TS_SUPPRESSION = /@ts-(?:expect-error|ignore)\s*$/

export function checkTestIntegrity(diff: PullRequestDiff): Finding[] {
  const findings: Finding[] = []

  for (const file of diff.files) {
    const isTest = matchesAnyGlob(TEST_GLOBS, file.path)

    if (isTest && file.status === 'removed') {
      findings.push({
        severity: 'high',
        file: file.path,
        line: null,
        description: 'A test file was deleted.',
        suggested_action:
          'Restore it, or state in the issue why the behaviour it covered no longer needs a test.',
        source: 'check:test-integrity',
        category: 'testing',
      })
      continue
    }

    if (isTest) findings.push(...inspectTestFile(file))
    findings.push(...inspectSuppressions(file))
  }

  return findings
}

function inspectTestFile(file: DiffFile): Finding[] {
  const findings: Finding[] = []

  const finding = (
    severity: Finding['severity'],
    description: string,
    suggested_action: string,
  ): Finding => ({
    severity,
    file: file.path,
    line: null,
    description,
    suggested_action,
    source: 'check:test-integrity',
    category: 'testing',
  })

  const addedSkips = file.addedLines.filter((line) => SKIP_MARKER.test(line))
  const removedSkips = file.removedLines.filter((line) => SKIP_MARKER.test(line))
  if (addedSkips.length > removedSkips.length) {
    findings.push(
      finding(
        'high',
        `${addedSkips.length - removedSkips.length} test(s) were skipped, marked todo, or marked failing.`,
        'Make the test pass instead. If it is genuinely obsolete, delete it in an issue that says so.',
      ),
    )
  }

  if (file.addedLines.some((line) => ONLY_MARKER.test(line))) {
    findings.push(
      finding(
        'high',
        'A `.only` marker was added, which silently stops every other test in the file from running.',
        'Remove it — it is a local debugging aid, not something to commit.',
      ),
    )
  }

  const vacuous = file.addedLines.filter((line) => VACUOUS_ASSERTION.test(line))
  if (vacuous.length > 0) {
    findings.push(
      finding(
        'high',
        `${vacuous.length} assertion(s) were added that cannot fail, e.g. \`${vacuous[0]?.trim().slice(0, 120)}\`.`,
        'Assert the actual behaviour. An assertion that always passes is worse than no test: it reports coverage it does not have.',
      ),
    )
  }

  // A test file that loses far more than it gains is usually assertions being
  // removed rather than a refactor. Not blocking on its own; visible.
  const removed = file.removedLines.length
  const added = file.addedLines.length
  if (removed > 20 && removed > added * 3) {
    findings.push(
      finding(
        'medium',
        `This test file lost ${removed} lines and gained ${added}, a substantial net reduction in coverage.`,
        'Confirm the removed cases are genuinely obsolete rather than inconvenient.',
      ),
    )
  }

  return findings
}

function inspectSuppressions(file: DiffFile): Finding[] {
  const findings: Finding[] = []

  for (const { pattern, detail } of BROAD_SUPPRESSION) {
    const added = file.addedLines.filter((line) => pattern.test(line))
    const removed = file.removedLines.filter((line) => pattern.test(line))
    if (added.length <= removed.length) continue

    findings.push({
      severity: 'high',
      file: file.path,
      line: null,
      description: `A broad suppression was added. ${detail}`,
      suggested_action:
        'Fix the underlying problem, or narrow the suppression to the single line and explain it.',
      source: 'check:test-integrity',
      category: 'testing',
    })
  }

  const bare = file.addedLines.filter((line) => BARE_TS_SUPPRESSION.test(line))
  if (bare.length > 0) {
    findings.push({
      severity: 'medium',
      file: file.path,
      line: null,
      description: `${bare.length} type suppression(s) were added with no explanation.`,
      suggested_action:
        'Add a reason after the directive, or fix the type error. An unexplained suppression is indistinguishable from giving up.',
      source: 'check:test-integrity',
      category: 'testing',
    })
  }

  return findings
}
