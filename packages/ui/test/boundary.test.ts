import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'

/**
 * `@newsdeck/ui` ships into browser bundles. Anything server-only here would
 * be shipped to every visitor.
 */
describe('client-safety boundary', () => {
  it('declares no runtime dependencies beyond the React peer', () => {
    const manifest = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url).pathname, 'utf8'),
    ) as { dependencies?: Record<string, string>; peerDependencies?: Record<string, string> }

    expect(manifest.dependencies).toBeUndefined()
    expect(Object.keys(manifest.peerDependencies ?? {})).toEqual(['react'])
  })
})
