import { dependencyChanges } from '../detect.ts'
import type { PullRequestDiff } from '../diff.ts'
import type { Finding } from '../review.ts'

/**
 * Dependency edits.
 *
 * AGENTS.md requires a stated reason for every new dependency. A machine cannot
 * judge the reason, but it can guarantee the change is never invisible.
 */
export function checkDependencies(diff: PullRequestDiff): Finding[] {
  const findings: Finding[] = []

  for (const file of diff.files) {
    for (const change of dependencyChanges(file)) {
      if (change.kind === 'added') {
        findings.push({
          severity: 'medium',
          file: file.path,
          line: null,
          description: `New dependency \`${change.name}@${change.to}\` added in ${file.path}.`,
          suggested_action:
            'State the concrete reason for the dependency in the pull request, per AGENTS.md section 5.',
          source: 'check:dependencies',
          category: 'dependencies',
        })
      }

      if (change.major && change.kind === 'upgraded') {
        findings.push({
          severity: 'high',
          file: file.path,
          line: null,
          description: `Major upgrade of \`${change.name}\`: ${change.from} to ${change.to}.`,
          suggested_action:
            'Major upgrades need a human. Confirm the changelog and that the full verification suite passes.',
          source: 'check:dependencies',
          category: 'dependencies',
        })
      }
    }
  }

  return findings
}
