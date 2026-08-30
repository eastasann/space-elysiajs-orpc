import { describe, expect, it } from 'bun:test'
import { matchesAnyGlob, matchesGlob } from '../src/glob.ts'

describe('matchesGlob', () => {
  it.each([
    ['.github/**', '.github/workflows/ci.yml', true],
    ['.github/**', '.github/loop-policy.json', true],
    ['.github/**', 'docs/architecture.md', false],
    ['docs/**', 'docs/adr/0001-x.md', true],
    ['*.md', 'README.md', true],
    ['*.md', 'docs/README.md', false],
    ['**/*.md', 'docs/adr/README.md', true],
    ['packages/auth/**', 'packages/auth/src/index.ts', true],
    ['packages/auth/**', 'packages/authz/src/index.ts', false],
    ['*/*/package.json', 'apps/api/package.json', true],
    ['*/*/package.json', 'package.json', false],
    ['**/.env*', 'apps/api/.env.local', true],
    ['docker-compose*.yml', 'docker-compose.dev-ports.yml', true],
    ['docker-compose*.yml', 'infra/docker-compose.yml', false],
    ['packages/*/src/**', 'packages/db/src/schema/users.ts', true],
  ])('%s vs %s -> %s', (pattern, path, expected) => {
    expect(matchesGlob(pattern, path)).toBe(expected)
  })

  it('does not let a prefix match a longer directory name', () => {
    expect(matchesGlob('infra/**', 'infrastructure/x.ts')).toBe(false)
  })

  it('treats a leading ./ as equivalent', () => {
    expect(matchesGlob('./docs/**', 'docs/x.md')).toBe(true)
  })
})

describe('matchesAnyGlob', () => {
  it('is true when any pattern matches', () => {
    expect(matchesAnyGlob(['infra/**', 'AGENTS.md'], 'AGENTS.md')).toBe(true)
  })

  it('is false when none match', () => {
    expect(matchesAnyGlob(['infra/**', 'AGENTS.md'], 'README.md')).toBe(false)
  })
})
