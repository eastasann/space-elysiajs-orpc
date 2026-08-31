import { describe, expect, test } from 'bun:test'
import { rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { applyFlags, parseArgs } from '../bin/loop.ts'
import { issueBudget, loadConfig } from '../src/config.ts'
import { currentBranch, ensureWorktree, isClean, removeWorktree } from '../src/git.ts'
import { createSandbox } from './support.ts'

describe('command line', () => {
  test('parses the four commands', () => {
    for (const command of ['status', 'once', 'watch', 'review']) {
      expect(parseArgs([command])).toMatchObject({ command })
    }
  })

  test('rejects an unknown command rather than guessing', () => {
    expect(parseArgs(['merge'])).toEqual({ error: 'Unknown command: merge' })
  })

  test('rejects a repository argument that is not owner/name', () => {
    // It ends up in the argv of a `gh` subprocess, so it is validated here.
    expect(parseArgs(['once', '--repo', 'owner/name; rm -rf /'])).toMatchObject({
      error: expect.stringContaining('--repo must be owner/name'),
    })
    expect(parseArgs(['once', '--repo', '../../etc'])).toMatchObject({
      error: expect.stringContaining('--repo must be owner/name'),
    })
    expect(parseArgs(['once', '--repo', 'owner/name'])).toMatchObject({ repo: 'owner/name' })
  })

  test('--dry-run is off unless asked for', () => {
    expect(parseArgs(['once'])).toMatchObject({ dryRun: false })
    expect(parseArgs(['once', '--dry-run'])).toMatchObject({ dryRun: true })
  })

  test('no arguments prints help rather than running anything', () => {
    expect(parseArgs([])).toEqual({ help: true })
  })
})

describe('configuration defaults', () => {
  test('are conservative when the environment says nothing', () => {
    const config = loadConfig({})

    expect(config.LOOP_UNATTENDED).toBe(false)
    expect(issueBudget(config)).toBe(1)
    expect(config.LOOP_CODING_FIX_ROUNDS).toBe(3)
    expect(config.LOOP_CI_FIX_ROUNDS).toBe(3)
  })

  test('unattended mode lifts the per-run ceiling and nothing else', () => {
    const unattended = loadConfig({ LOOP_UNATTENDED: 'true' })

    expect(issueBudget(unattended)).toBe(0)
    // Per-issue limits are untouched: unattended is not unbounded.
    expect(unattended.LOOP_CODING_FIX_ROUNDS).toBe(3)
    expect(unattended.LOOP_MAX_MODEL_INVOCATIONS_PER_HOUR).toBeGreaterThan(0)
    expect(unattended.LOOP_MAX_ISSUES_PER_DAY).toBeGreaterThan(0)
  })

  test('an explicit ceiling still wins in unattended mode', () => {
    expect(issueBudget(loadConfig({ LOOP_UNATTENDED: 'true', LOOP_MAX_ISSUES: '2' }))).toBe(2)
  })

  test('rejects limits outside their range', () => {
    expect(() => loadConfig({ LOOP_MAX_ISSUES: '-1' })).toThrow()
    expect(() => loadConfig({ LOOP_CODING_FIX_ROUNDS: '99' })).toThrow()
    expect(() => loadConfig({ LOOP_POLL_INTERVAL_SECONDS: '1' })).toThrow()
  })

  test('--unattended and --max-issues override the environment', () => {
    const args = parseArgs(['watch', '--unattended', '--max-issues', '2'])
    if ('help' in args || 'error' in args) throw new Error('expected parsed args')

    const config = applyFlags(loadConfig({}), args)
    expect(config.LOOP_UNATTENDED).toBe(true)
    expect(issueBudget(config)).toBe(2)
  })
})

describe('worktree isolation', () => {
  test('creates, re-attaches to, and removes a worktree without touching the main checkout', async () => {
    const sandbox = await createSandbox()
    try {
      // Uncommitted work in the developer's checkout, which must survive.
      await writeFile(join(sandbox.repository, 'in-progress.txt'), 'mine\n', 'utf8')

      const path = join(sandbox.root, 'wt', 'issue-1')
      const first = await ensureWorktree({
        repository: sandbox.repository,
        path,
        branch: 'agent/issue-1-a-thing',
        base: 'origin/main',
      })
      expect(first.created).toBe(true)
      expect((await stat(path)).isDirectory()).toBe(true)
      expect(await currentBranch(path)).toBe('agent/issue-1-a-thing')

      // Re-running is idempotent rather than a second worktree.
      expect(
        (
          await ensureWorktree({
            repository: sandbox.repository,
            path,
            branch: 'agent/issue-1-a-thing',
            base: 'origin/main',
          })
        ).created,
      ).toBe(false)

      await removeWorktree(sandbox.repository, path)
      expect(stat(path)).rejects.toThrow()

      // The main checkout kept its branch and its uncommitted file.
      expect(await currentBranch(sandbox.repository)).toBe('main')
      expect(await isClean(sandbox.repository)).toBe(false)
      expect((await stat(join(sandbox.repository, 'in-progress.txt'))).isFile()).toBe(true)
    } finally {
      await sandbox.cleanup()
    }
  })

  test('refuses to create a worktree for a branch it does not own', async () => {
    const sandbox = await createSandbox()
    try {
      expect(
        ensureWorktree({
          repository: sandbox.repository,
          path: join(sandbox.root, 'wt', 'main'),
          branch: 'main',
          base: 'origin/main',
        }),
      ).rejects.toThrow(/non-agent branch/)
    } finally {
      await sandbox.cleanup()
    }
  })
})

describe('journal recovery', () => {
  test('a corrupt journal reads as empty instead of wedging the runner', async () => {
    const sandbox = await createSandbox()
    try {
      const { readJournal } = await import('../src/journal.ts')
      const path = join(sandbox.repository, '.loop', 'state.json')

      await Bun.write(path, '{ not json')
      expect((await readJournal(path)).runs).toEqual([])

      await Bun.write(path, JSON.stringify({ version: 9, runs: 'nope' }))
      expect((await readJournal(path)).runs).toEqual([])

      await rm(path)
      expect((await readJournal(path)).runs).toEqual([])
    } finally {
      await sandbox.cleanup()
    }
  })
})
