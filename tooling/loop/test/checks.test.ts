import { describe, expect, it } from 'bun:test'
import {
  checkClientSafety,
  checkDebugArtifacts,
  checkDependencies,
  checkMigrations,
  checkSecrets,
  checkTestCoverage,
  runDeterministicChecks,
} from '../src/checks/index.ts'
import { diffOf } from './support/fixtures.ts'

describe('checkSecrets', () => {
  it.each([
    ['a GitHub token', `const t = 'ghp_${'a'.repeat(36)}'`],
    ['an AWS access key id', 'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE'],
    ['a private key block', '-----BEGIN RSA PRIVATE KEY-----'],
    ['an Anthropic key', "key: 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz'"],
    ['a long quoted credential', `apiKey: "${'x'.repeat(40)}"`],
  ])('flags %s', (_label, line) => {
    const findings = checkSecrets(diffOf([{ path: 'apps/api/src/x.ts', added: [line] }]))

    expect(findings).toHaveLength(1)
    expect(findings[0]?.severity).toBe('critical')
  })

  it('never echoes the matched value into the finding', () => {
    const secret = `ghp_${'b'.repeat(36)}`
    const findings = checkSecrets(diffOf([{ path: 'a.ts', added: [`const t = '${secret}'`] }]))

    expect(JSON.stringify(findings)).not.toContain(secret)
  })

  it.each([
    [
      "this repository's documented local signing key",
      'AUTH_LOCAL_SIGNING_KEY=local-development-signing-key-change-me',
    ],
    ['a short password in an example file', 'POSTGRES_PASSWORD=newsdeck_local_password'],
    ['a plain URL', 'DATABASE_URL=postgres://newsdeck:newsdeck@localhost:5432/newsdeck'],
    ['a comment about tokens', '// the token is read from the Authorization header'],
  ])('does not flag %s', (_label, line) => {
    expect(checkSecrets(diffOf([{ path: '.env.example', added: [line] }]))).toEqual([])
  })

  it('ignores removed lines', () => {
    const findings = checkSecrets(
      diffOf([{ path: 'a.ts', removed: [`const t = 'ghp_${'c'.repeat(36)}'`] }]),
    )

    expect(findings).toEqual([])
  })
})

describe('checkMigrations', () => {
  it('flags a destructive statement', () => {
    const findings = checkMigrations(
      diffOf([
        {
          path: 'packages/db/drizzle/0002_x.sql',
          added: ['DROP TABLE "articles";'],
          status: 'added',
        },
      ]),
    )

    expect(findings.some((f) => f.description.includes('DROP TABLE'))).toBe(true)
  })

  it.each([
    ['ALTER TABLE "a" DROP COLUMN "b";'],
    ['TRUNCATE TABLE "a";'],
    ['ALTER TABLE "a" DROP CONSTRAINT "c";'],
  ])('flags %s', (line) => {
    const findings = checkMigrations(
      diffOf([{ path: 'packages/db/drizzle/0002_x.sql', added: [line], status: 'added' }]),
    )

    expect(findings.filter((f) => f.category === 'migration').length).toBeGreaterThan(0)
  })

  it('does not flag DROP INDEX, which loses no data', () => {
    const findings = checkMigrations(
      diffOf([
        { path: 'packages/db/drizzle/0002_x.sql', added: ['DROP INDEX "idx";'], status: 'added' },
      ]),
    )

    expect(findings).toEqual([])
  })

  it('flags a schema change with no generated migration', () => {
    const findings = checkMigrations(
      diffOf([{ path: 'packages/db/src/schema/sources.ts', added: ['export const sources = 1'] }]),
    )

    expect(findings.some((f) => f.description.includes('no new migration'))).toBe(true)
  })

  it('accepts a schema change accompanied by a migration', () => {
    const findings = checkMigrations(
      diffOf([
        { path: 'packages/db/src/schema/sources.ts', added: ['export const sources = 1'] },
        {
          path: 'packages/db/drizzle/0002_x.sql',
          added: ['CREATE TABLE "sources" ();'],
          status: 'added',
        },
      ]),
    )

    expect(findings).toEqual([])
  })
})

describe('checkDependencies', () => {
  it('reports a newly added dependency', () => {
    const findings = checkDependencies(
      diffOf([{ path: 'apps/api/package.json', added: ['    "lodash": "4.17.21",'] }]),
    )

    expect(findings[0]?.severity).toBe('medium')
    expect(findings[0]?.description).toContain('lodash')
  })

  it('escalates a major upgrade', () => {
    const findings = checkDependencies(
      diffOf([
        {
          path: 'package.json',
          removed: ['    "zod": "3.24.1",'],
          added: ['    "zod": "4.5.4",'],
        },
      ]),
    )

    expect(findings.some((f) => f.severity === 'high')).toBe(true)
  })

  it('ignores a patch bump', () => {
    const findings = checkDependencies(
      diffOf([
        {
          path: 'package.json',
          removed: ['    "zod": "4.5.3",'],
          added: ['    "zod": "4.5.4",'],
        },
      ]),
    )

    expect(findings.filter((f) => f.severity === 'high')).toEqual([])
  })

  it('ignores non-manifest files', () => {
    expect(
      checkDependencies(diffOf([{ path: 'apps/api/src/x.ts', added: ['    "zod": "4.5.4",'] }])),
    ).toEqual([])
  })
})

describe('checkDebugArtifacts', () => {
  it.each([
    ['a debugger statement', 'debugger'],
    ['a focused test', "it.only('x', () => {})"],
    ['a skipped test', "describe.skip('x', () => {})"],
  ])('flags %s', (_label, line) => {
    const findings = checkDebugArtifacts(
      diffOf([{ path: 'apps/api/test/x.test.ts', added: [line] }]),
    )

    expect(findings).toHaveLength(1)
  })

  it('does not flag describe.skipIf, which this repository uses deliberately', () => {
    const findings = checkDebugArtifacts(
      diffOf([
        {
          path: 'packages/db/test/x.integration.test.ts',
          added: ["describe.skipIf(!TEST_DATABASE_URL)('db', () => {})"],
        },
      ]),
    )

    expect(findings).toEqual([])
  })

  it('ignores non-code files', () => {
    expect(checkDebugArtifacts(diffOf([{ path: 'docs/x.md', added: ['debugger'] }]))).toEqual([])
  })
})

describe('checkClientSafety', () => {
  it.each([
    ["import { readFileSync } from 'node:fs'"],
    ["import { drizzle } from 'drizzle-orm/postgres-js'"],
    ["import pino from 'pino'"],
    ["import { createDatabase } from '@newsdeck/db'"],
  ])('flags %s inside a client-safe package', (line) => {
    const findings = checkClientSafety(
      diffOf([{ path: 'packages/api-contract/src/index.ts', added: [line] }]),
    )

    expect(findings).toHaveLength(1)
    expect(findings[0]?.severity).toBe('high')
  })

  it('allows imports that are genuinely client-safe', () => {
    const findings = checkClientSafety(
      diffOf([
        {
          path: 'packages/api-client/src/client.ts',
          added: ["import { oc } from '@orpc/contract'", "import { z } from 'zod'"],
        },
      ]),
    )

    expect(findings).toEqual([])
  })

  it('does not police server packages', () => {
    const findings = checkClientSafety(
      diffOf([{ path: 'packages/db/src/client.ts', added: ["import postgres from 'postgres'"] }]),
    )

    expect(findings).toEqual([])
  })
})

describe('checkTestCoverage', () => {
  it('flags source changes with no accompanying test change', () => {
    const findings = checkTestCoverage(
      diffOf([{ path: 'apps/api/src/modules/system/service.ts', added: ['const x = 1'] }]),
    )

    expect(findings).toHaveLength(1)
    expect(findings[0]?.severity).toBe('medium')
  })

  it('accepts source changes with a test change', () => {
    const findings = checkTestCoverage(
      diffOf([
        { path: 'apps/api/src/modules/system/service.ts', added: ['const x = 1'] },
        { path: 'apps/api/test/server.test.ts', added: ["it('x', () => {})"] },
      ]),
    )

    expect(findings).toEqual([])
  })

  it('does not ask for tests on a documentation-only change', () => {
    expect(checkTestCoverage(diffOf([{ path: 'docs/roadmap.md', added: ['text'] }]))).toEqual([])
  })

  it('does not ask for tests on a stylesheet change', () => {
    expect(
      checkTestCoverage(
        diffOf([{ path: 'packages/ui/src/styles.css', added: ['.a { color: red }'] }]),
      ),
    ).toEqual([])
  })
})

describe('runDeterministicChecks', () => {
  it('returns nothing for a clean documentation change', () => {
    expect(
      runDeterministicChecks(diffOf([{ path: 'docs/roadmap.md', added: ['- a note'] }])),
    ).toEqual([])
  })

  it('aggregates findings from every check', () => {
    const findings = runDeterministicChecks(
      diffOf([
        { path: 'packages/api-contract/src/index.ts', added: ["import fs from 'node:fs'"] },
        { path: 'apps/api/src/x.ts', added: ['debugger'] },
      ]),
    )

    const sources = new Set(findings.map((finding) => finding.source))
    expect(sources.has('check:client-safety')).toBe(true)
    expect(sources.has('check:debug-artifacts')).toBe(true)
    expect(sources.has('check:tests')).toBe(true)
  })
})
