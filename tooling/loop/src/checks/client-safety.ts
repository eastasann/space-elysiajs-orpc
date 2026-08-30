import type { PullRequestDiff } from '../diff.ts'
import { matchesAnyGlob } from '../glob.ts'
import type { Finding } from '../review.ts'

/**
 * Packages compiled into browser and React Native bundles.
 *
 * Kept in step with `docs/architecture.md#packages` and with the boundary tests
 * inside those packages. This check exists in addition to those tests so that a
 * violation is reported as a review finding on the pull request, next to the
 * line that caused it, rather than only as a failing suite.
 */
const CLIENT_SAFE_GLOBS = [
  'packages/api-contract/src/**',
  'packages/api-client/src/**',
  'packages/ui/src/**',
]

const FORBIDDEN_SPECIFIERS = [
  /^node:/,
  /^bun:/,
  /^bun$/,
  /^drizzle-orm/,
  /^postgres$/,
  /^ioredis$/,
  /^bullmq$/,
  /^pino/,
  /^elysia/,
  /^jose$/,
  /^@orpc\/server/,
  /^@newsdeck\/(db|auth|logger|jobs|loop)$/,
]

const IMPORT_LINE = /(?:^|\s)(?:import|export)\b[^'"]*from\s+['"]([^'"]+)['"]/

/** Server-only imports added to a package that ships to clients. */
export function checkClientSafety(diff: PullRequestDiff): Finding[] {
  const findings: Finding[] = []

  for (const file of diff.files) {
    if (!matchesAnyGlob(CLIENT_SAFE_GLOBS, file.path)) continue

    for (const line of file.addedLines) {
      const specifier = IMPORT_LINE.exec(line)?.[1]
      if (specifier === undefined) continue
      if (!FORBIDDEN_SPECIFIERS.some((pattern) => pattern.test(specifier))) continue

      findings.push({
        severity: 'high',
        file: file.path,
        line: null,
        description: `${file.path} imports \`${specifier}\`, which is server-only, into a client-safe package.`,
        suggested_action:
          'Remove the import. Relaxing the client-safe boundary is an architectural decision, not an implementation detail — see AGENTS.md section 4.',
        source: 'check:client-safety',
        category: 'architecture',
      })
    }
  }

  return findings
}
