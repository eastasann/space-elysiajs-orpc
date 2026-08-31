import { describe, expect, it } from 'bun:test'
import { dependencyChanges } from '../src/detect.ts'
import { diffOf } from './support/fixtures.ts'

/**
 * Telling a dependency from a script.
 *
 * The loop reported `"docker:smoke": "docker compose up -d --build --wait"` as
 * a new dependency on a real pull request, because the line matcher accepts any
 * `"key": "value"` pair and a package.json diff contains `scripts` too. A
 * specifier is a semver range or one of npm's protocols; a script is neither.
 */
describe('dependency detection ignores everything that is not a specifier', () => {
  function change(added: string[], path = 'package.json') {
    const file = diffOf([{ path, added }]).files[0]
    if (file === undefined) throw new Error('expected one file in the fixture')
    return dependencyChanges(file)
  }

  it('does not treat an added script as a dependency', () => {
    expect(change(['    "docker:smoke": "docker compose up -d --build --wait"'])).toEqual([])
    expect(change(['    "typecheck": "tsc --noEmit"'])).toEqual([])
    expect(change(['    "loop:watch": "bun tooling/local-runner/bin/loop.ts watch"'])).toEqual([])
  })

  it('does not treat other manifest metadata as a dependency', () => {
    expect(change(['    "description": "Local execution plane for the loop."'])).toEqual([])
    expect(change(['    "type": "module"'])).toEqual([])
  })

  it('still detects a real dependency', () => {
    const [added] = change(['    "zod": "4.5.4"'])

    expect(added?.name).toBe('zod')
    expect(added?.kind).toBe('added')
  })

  it('accepts the specifier forms this repository actually uses', () => {
    for (const [name, value] of [
      ['@newsdeck/loop', 'workspace:*'],
      ['pino', '^10.3.1'],
      ['react', '19.2.8'],
      ['some-fork', 'github:owner/repo#v1'],
      ['aliased', 'npm:real-package@1.2.3'],
    ] as const) {
      expect(change([`    "${name}": "${value}"`]).map((entry) => entry.name)).toEqual([name])
    }
  })

  it('ignores files that are not manifests', () => {
    expect(change(['    "zod": "4.5.4"'], 'README.md')).toEqual([])
  })
})
