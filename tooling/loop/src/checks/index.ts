import type { PullRequestDiff } from '../diff.ts'
import type { Finding } from '../review.ts'
import { checkClientSafety } from './client-safety.ts'
import { checkDebugArtifacts } from './debug-artifacts.ts'
import { checkDependencies } from './dependencies.ts'
import { checkMigrations } from './migrations.ts'
import { checkSecrets } from './secrets.ts'
import { checkTestIntegrity } from './test-integrity.ts'
import { checkTestCoverage } from './tests.ts'

export {
  checkClientSafety,
  checkDebugArtifacts,
  checkDependencies,
  checkMigrations,
  checkSecrets,
  checkTestCoverage,
  checkTestIntegrity,
}

/**
 * Every deterministic check, in one pass.
 *
 * These run whether or not a review agent is configured, so the merge gate is
 * never reduced to "the model said yes". They read the diff and nothing else.
 */
export function runDeterministicChecks(diff: PullRequestDiff): Finding[] {
  return [
    ...checkSecrets(diff),
    ...checkClientSafety(diff),
    ...checkMigrations(diff),
    ...checkDependencies(diff),
    ...checkDebugArtifacts(diff),
    ...checkTestCoverage(diff),
    ...checkTestIntegrity(diff),
  ]
}
