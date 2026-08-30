import { findDestructiveSql } from '../detect.ts'
import type { PullRequestDiff } from '../diff.ts'
import { matchesAnyGlob } from '../glob.ts'
import type { Finding } from '../review.ts'

const MIGRATION_GLOBS = ['packages/db/drizzle/**/*.sql']
const SCHEMA_GLOBS = ['packages/db/src/schema/**']

/**
 * Migration risks.
 *
 * Two failure modes matter here and both are mechanically detectable: SQL that
 * destroys data, and a schema edit that never produced a migration — which
 * passes every test locally and then diverges the moment it is deployed.
 */
export function checkMigrations(diff: PullRequestDiff): Finding[] {
  const findings: Finding[] = []

  for (const file of diff.files) {
    if (!matchesAnyGlob(MIGRATION_GLOBS, file.path)) continue

    for (const statement of findDestructiveSql(file.addedLines)) {
      findings.push({
        severity: 'high',
        file: file.path,
        line: null,
        description: `Destructive migration statement: ${statement.line}`,
        suggested_action:
          'Confirm the data loss is intended and reversible, and have a human approve this change.',
        source: 'check:migrations',
        category: 'migration',
      })
    }
  }

  const touchedSchema = diff.files.some((file) => matchesAnyGlob(SCHEMA_GLOBS, file.path))
  const addedMigration = diff.files.some(
    (file) => matchesAnyGlob(MIGRATION_GLOBS, file.path) && file.status === 'added',
  )

  if (touchedSchema && !addedMigration) {
    findings.push({
      severity: 'high',
      file: null,
      line: null,
      description:
        'The Drizzle schema changed but no new migration was added under packages/db/drizzle/.',
      suggested_action: 'Run `bun run db:generate` and commit the generated SQL.',
      source: 'check:migrations',
      category: 'migration',
    })
  }

  return findings
}
