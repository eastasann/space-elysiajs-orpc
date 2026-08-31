import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The Dockerfile's manifest list against the actual workspace members.
 *
 * `infra/docker/Dockerfile` copies each workspace's `package.json` before
 * installing, so that editing source costs a source copy rather than a
 * reinstall. That list is hand-maintained, and the root `package.json` declares
 * workspaces with a glob — so adding `tooling/local-runner` silently desynced
 * them, and `bun install --frozen-lockfile` failed inside every image with
 * "lockfile had changes, but lockfile is frozen".
 *
 * Nothing on a developer's machine reproduces that: the local install has every
 * manifest. It only appeared in CI, on a change that had nothing to do with
 * Docker. For a loop that merges its own work, drift that is invisible locally
 * and fatal remotely is exactly what needs a test.
 */

const ROOT = join(import.meta.dir, '..', '..', '..')

function workspaceMembers(): string[] {
  const root = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
    workspaces: string[]
  }

  const members: string[] = []
  for (const pattern of root.workspaces) {
    // Every declared pattern is `<dir>/*` in this repository.
    const directory = pattern.replace(/\/\*$/, '')
    const glob = new Bun.Glob(`${directory}/*/package.json`)
    for (const match of glob.scanSync({ cwd: ROOT })) {
      members.push(match.replaceAll('\\', '/'))
    }
  }
  return members.sort()
}

describe('the Dockerfile knows every workspace', () => {
  const dockerfile = readFileSync(join(ROOT, 'infra', 'docker', 'Dockerfile'), 'utf8')

  it('copies a manifest for each workspace member', () => {
    const missing = workspaceMembers().filter((manifest) => !dockerfile.includes(manifest))

    expect(
      missing,
      `add a COPY line to infra/docker/Dockerfile for: ${missing.join(', ')}`,
    ).toEqual([])
  })

  it('copies no manifest that no longer exists', () => {
    const declared = [...dockerfile.matchAll(/^COPY (\S+\/package\.json) \S+$/gm)].map(
      (match) => match[1] as string,
    )
    const members = new Set(workspaceMembers())
    const stale = declared.filter((manifest) => !members.has(manifest))

    expect(stale, `remove the COPY line(s) for: ${stale.join(', ')}`).toEqual([])
  })

  it('finds the members it is asserting about, so the test is not vacuous', () => {
    const members = workspaceMembers()

    expect(members.length).toBeGreaterThan(5)
    expect(members).toContain('tooling/loop/package.json')
  })
})
