import { describe, expect, it } from 'bun:test'
import { classifyRisk } from '../src/risk.ts'
import { diffOf, realPolicy } from './support/fixtures.ts'

const policy = realPolicy()

function riskOf(files: Parameters<typeof diffOf>[0], labels: string[] = []): string {
  return classifyRisk({ diff: diffOf(files), labels, policy }).risk
}

describe('path-based classification', () => {
  it.each([
    ['README.md', 'low'],
    ['docs/roadmap.md', 'low'],
    ['apps/web/src/routes/index.tsx', 'medium'],
    ['packages/db/src/schema/users.ts', 'medium'],
    ['packages/db/drizzle/0001_x.sql', 'medium'],
    ['apps/api/package.json', 'medium'],
    ['.github/workflows/ci.yml', 'high'],
    ['tooling/loop/src/risk.ts', 'high'],
    ['infra/proxy/nginx.conf', 'high'],
    ['docker-compose.yml', 'high'],
    ['packages/auth/src/providers/local.ts', 'high'],
    ['AGENTS.md', 'high'],
    ['docs/architecture.md', 'high'],
    ['docs/adr/0004-authentication-abstraction.md', 'high'],
    ['.env.example', 'high'],
  ])('%s is %s risk', (path, expected) => {
    expect(riskOf([{ path }])).toBe(expected)
  })

  it('takes the highest risk among all changed paths', () => {
    expect(riskOf([{ path: 'README.md' }, { path: 'packages/auth/src/index.ts' }])).toBe('high')
  })

  it('keeps ordinary application work at medium so automation stays useful', () => {
    expect(
      riskOf([
        { path: 'apps/api/src/modules/sources/service.ts' },
        { path: 'apps/api/test/server.test.ts' },
        { path: 'packages/api-contract/src/sources/contract.ts' },
      ]),
    ).toBe('medium')
  })
})

describe('label-based classification', () => {
  it('escalates when a risk label is present', () => {
    expect(riskOf([{ path: 'README.md' }], ['risk:high'])).toBe('high')
  })

  it('never downgrades a sensitive path', () => {
    // The cheapest imaginable bypass: label a workflow change as low risk.
    expect(riskOf([{ path: '.github/workflows/ci.yml' }], ['risk:low'])).toBe('high')
  })

  it('ignores unrelated labels', () => {
    expect(riskOf([{ path: 'README.md' }], ['agent:ready', 'bug'])).toBe('low')
  })

  it('records the label as a reason', () => {
    const assessment = classifyRisk({
      diff: diffOf([{ path: 'README.md' }]),
      labels: ['risk:medium'],
      policy,
    })

    expect(assessment.reasons.some((reason) => reason.source === 'label')).toBe(true)
  })
})

describe('escalations', () => {
  it('escalates a destructive migration to high', () => {
    expect(
      riskOf([
        {
          path: 'packages/db/drizzle/0002_drop.sql',
          added: ['DROP TABLE "articles";'],
          status: 'added',
        },
      ]),
    ).toBe('high')
  })

  it('leaves an additive migration at medium', () => {
    expect(
      riskOf([
        {
          path: 'packages/db/drizzle/0002_add.sql',
          added: ['CREATE TABLE "sources" (', '  "id" uuid PRIMARY KEY', ');'],
          status: 'added',
        },
      ]),
    ).toBe('medium')
  })

  it('escalates a removed public contract export to high', () => {
    expect(
      riskOf([
        {
          path: 'packages/api-contract/src/index.ts',
          removed: ['export { contract } from ./contract.ts'],
          added: [],
        },
      ]),
    ).toBe('high')
  })

  it('does not treat a reordered export list as breaking', () => {
    expect(
      riskOf([
        {
          path: 'packages/api-contract/src/index.ts',
          removed: ['export { alpha, beta }'],
          added: ['export { beta, alpha }'],
        },
      ]),
    ).toBe('medium')
  })

  it('escalates a major dependency upgrade to high', () => {
    expect(
      riskOf([
        {
          path: 'package.json',
          removed: ['    "zod": "3.24.1",'],
          added: ['    "zod": "4.5.4",'],
        },
      ]),
    ).toBe('high')
  })

  it('leaves a patch upgrade at medium', () => {
    expect(
      riskOf([
        {
          path: 'package.json',
          removed: ['    "zod": "4.5.3",'],
          added: ['    "zod": "4.5.4",'],
        },
      ]),
    ).toBe('medium')
  })

  it('escalates a large-scale restructuring to high', () => {
    const many = Array.from(
      { length: policy.risk.escalations.maxChangedFiles + 1 },
      (_, index) => ({
        path: `docs/note-${index}.md`,
      }),
    )

    expect(riskOf(many)).toBe('high')
  })

  it('escalates a large-scale deletion to high', () => {
    const removed = Array.from(
      { length: policy.risk.escalations.maxDeletedLines + 1 },
      (_, index) => `line ${index}`,
    )

    expect(riskOf([{ path: 'docs/roadmap.md', removed }])).toBe('high')
  })
})

describe('reasons', () => {
  it('always explains the classification', () => {
    const assessment = classifyRisk({
      diff: diffOf([{ path: 'packages/auth/src/index.ts' }]),
      labels: [],
      policy,
    })

    expect(assessment.risk).toBe('high')
    expect(assessment.reasons.length).toBeGreaterThan(1)
    expect(assessment.reasons.some((reason) => reason.detail.includes('authentication'))).toBe(true)
  })
})
