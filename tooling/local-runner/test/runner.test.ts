import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { selectNextIssue } from '@newsdeck/loop'
import { probeClaude } from '../src/claude.ts'
import { extractReview } from '../src/claude-agent.ts'
import { readJournal } from '../src/journal.ts'
import { acquireLock } from '../src/lock.ts'
import { advance, planDryRun, runOnce, workIssue } from '../src/orchestrator.ts'
import { preflight } from '../src/preflight.ts'
import {
  approvingReview,
  createSandbox,
  failingVerification,
  fakeGh,
  issueFixture,
  passingVerification,
  scriptedCodingAgent,
  scriptedReviewAgent,
  testDeps,
} from './support.ts'

/**
 * Scenarios A-J from the runner specification.
 *
 * Claude and GitHub are faked; git is real. Nothing here reaches the network
 * and nothing here spends model usage.
 */

const write = (task: { worktree: string }, name: string, contents: string) =>
  writeFile(join(task.worktree, name), contents, 'utf8')

describe('A — an eligible low-risk issue is selected and claimable', () => {
  test('selects the ready issue and skips the rest', () => {
    const result = selectNextIssue([
      { number: 1, title: 'Ready', state: 'open', labels: ['agent:ready', 'risk:low'], body: null },
      {
        number: 2,
        title: 'Claimed',
        state: 'open',
        labels: ['agent:ready', 'agent:in-progress'],
        body: null,
      },
      {
        number: 3,
        title: 'Blocked',
        state: 'open',
        labels: ['agent:ready', 'agent:blocked'],
        body: null,
      },
      { number: 4, title: 'Unvetted', state: 'open', labels: [], body: null },
    ])

    expect(result.selected?.number).toBe(1)
  })

  test('claiming moves the labels on GitHub', async () => {
    const sandbox = await createSandbox()
    try {
      const gh = fakeGh({ issues: [issueFixture(1, 'Add a thing')] })
      const deps = testDeps({
        repository: sandbox.repository,
        gh,
        coding: scriptedCodingAgent([(task) => write(task, 'thing.txt', 'thing\n')]),
        review: scriptedReviewAgent([approvingReview()]),
      })

      await workIssue(deps, {
        number: 1,
        title: 'Add a thing',
        state: 'open',
        labels: ['agent:ready'],
        body: 'Add it.',
      })

      expect(gh.labelsOf(1)).toEqual(['agent:review'])
      expect(gh.calls).toContain('addLabels(1,agent:in-progress)')
      expect(gh.calls).toContain('removeLabel(1,agent:ready)')
    } finally {
      await sandbox.cleanup()
    }
  })
})

describe('B — no Claude authentication', () => {
  test('probeClaude reports not-authenticated without touching credentials', async () => {
    const availability = await probeClaude({
      which: () => '/usr/local/bin/claude',
      runner: async (_command, args) =>
        args[0] === '--version'
          ? { code: 0, stdout: '2.1.251\n', stderr: '', timedOut: false, display: '' }
          : {
              code: 0,
              stdout: JSON.stringify({ loggedIn: false }),
              stderr: '',
              timedOut: false,
              display: '',
            },
      env: {},
    })

    expect(availability.available).toBe(false)
    if (!availability.available) {
      expect(availability.reason).toBe('not-authenticated')
      expect(availability.remedy).toContain('claude auth login')
    }
  })

  // Bun's default 5s is too tight for what this actually does: it builds a real
  // git repository on disk and then runs `preflight`, which probes for `gh` and
  // `claude` by spawning them. On CI those binaries are absent, so each probe
  // pays a full PATH lookup and spawn failure, on a runner already hosting
  // Postgres and Valkey. It timed out at 5001ms on two consecutive commits that
  // touched none of this code.
  //
  // The assertion is unchanged — the budget is, because the work is genuinely
  // variable and a timeout is not a finding.
  test('preflight refuses before any issue is claimed', async () => {
    const sandbox = await createSandbox()
    try {
      const lockPath = join(sandbox.repository, '.loop', 'runner.lock')
      const result = await preflight({ repository: sandbox.repository, lockPath })

      // `gh` and `claude` may or may not exist on the machine running these
      // tests; what must hold is that any problem makes `ok` false, which is
      // what the CLI checks before it claims anything.
      expect(result.ok).toBe(result.problems.length === 0)
    } finally {
      await sandbox.cleanup()
    }
  }, 30_000)

  test('an ANTHROPIC_API_KEY in the environment is reported, not silently used', async () => {
    const availability = await probeClaude({
      which: () => '/usr/local/bin/claude',
      runner: async (_command, args) =>
        args[0] === '--version'
          ? { code: 0, stdout: '2.1.251\n', stderr: '', timedOut: false, display: '' }
          : {
              code: 0,
              stdout: JSON.stringify({ loggedIn: true, authMethod: 'oauth_token' }),
              stderr: '',
              timedOut: false,
              display: '',
            },
      env: { ANTHROPIC_API_KEY: 'sk-ant-example' },
    })

    expect(availability.available).toBe(true)
    if (availability.available) expect(availability.warning).toContain('bill the API')
  })
})

describe('C — the coding agent succeeds', () => {
  test('verifies, commits, pushes and opens a pull request', async () => {
    const sandbox = await createSandbox()
    try {
      const gh = fakeGh({ issues: [issueFixture(7, 'Add a source list')] })
      const coding = scriptedCodingAgent([
        (task) => write(task, 'source.ts', 'export const a = 1\n'),
      ])
      const deps = testDeps({
        repository: sandbox.repository,
        gh,
        coding,
        review: scriptedReviewAgent([approvingReview()]),
      })

      const outcome = await workIssue(deps, {
        number: 7,
        title: 'Add a source list',
        state: 'open',
        labels: ['agent:ready'],
        body: 'List them.',
      })

      expect(outcome.status).toBe('opened')
      expect(outcome.pullRequest).toBe(100)
      expect(outcome.branch).toBe('agent/issue-7-add-a-source-list')
      expect(gh.created[0]?.body).toContain('Closes #7')
      expect(gh.created[0]?.base).toBe('main')
      expect(coding.rounds).toHaveLength(1)

      const journal = await readJournal(join(sandbox.repository, '.loop', 'state.json'))
      expect(journal.runs[0]?.status).toBe('awaiting-review')
      expect(journal.runs[0]?.pullRequest).toBe(100)
    } finally {
      await sandbox.cleanup()
    }
  })
})

describe('C2 — a fresh worktree gets its dependencies', () => {
  test('installs before anything is verified, and blocks when that fails', async () => {
    const sandbox = await createSandbox()
    try {
      const gh = fakeGh({ issues: [issueFixture(40, 'Needs deps')] })
      const order: string[] = []
      const coding = scriptedCodingAgent([
        (task) => {
          order.push('code')
          return write(task, 'a.ts', 'export const j = 10\n')
        },
      ])

      const deps = testDeps({
        repository: sandbox.repository,
        gh,
        coding,
        review: scriptedReviewAgent([approvingReview()]),
        installer: async (command, args) => {
          order.push(`${command} ${args.join(' ')}`)
          return {
            code: 1,
            stdout: '',
            stderr: 'lockfile is out of date',
            timedOut: false,
            display: '',
          }
        },
        verifier: async () => {
          order.push('verify')
          return passingVerification()
        },
      })

      const outcome = await workIssue(deps, {
        number: 40,
        title: 'Needs deps',
        state: 'open',
        labels: ['agent:ready'],
        body: 'Install them.',
      })

      // A failed install stops the run before the agent is even asked to work,
      // rather than letting every check fail for an unrelated reason.
      expect(outcome.status).toBe('blocked')
      expect(outcome.detail).toContain('lockfile is out of date')
      expect(order).toEqual(['bun install --frozen-lockfile'])
      expect(coding.rounds).toHaveLength(0)
      expect(gh.labelsOf(40)).toEqual(['agent:blocked'])
    } finally {
      await sandbox.cleanup()
    }
  })

  test('installs once, before the first coding round', async () => {
    const sandbox = await createSandbox()
    try {
      const gh = fakeGh({ issues: [issueFixture(41, 'Order matters')] })
      const order: string[] = []
      const coding = scriptedCodingAgent([
        (task) => {
          order.push('code')
          return write(task, 'b.ts', 'export const k = 11\n')
        },
      ])

      const deps = testDeps({
        repository: sandbox.repository,
        gh,
        coding,
        review: scriptedReviewAgent([approvingReview()]),
        installer: async (command, args) => {
          order.push(`${command} ${args.join(' ')}`)
          return { code: 0, stdout: '', stderr: '', timedOut: false, display: '' }
        },
        verifier: async () => {
          order.push('verify')
          return passingVerification()
        },
      })

      await workIssue(deps, {
        number: 41,
        title: 'Order matters',
        state: 'open',
        labels: ['agent:ready'],
        body: 'Order it.',
      })

      expect(order).toEqual(['bun install --frozen-lockfile', 'code', 'verify'])
    } finally {
      await sandbox.cleanup()
    }
  })
})

describe('D — verification fails', () => {
  test('runs a bounded fix loop and blocks when it is spent', async () => {
    const sandbox = await createSandbox()
    try {
      const gh = fakeGh({ issues: [issueFixture(8, 'Break something')] })
      const coding = scriptedCodingAgent([
        (task) => write(task, 'broken.ts', 'export const b = 2\n'),
      ])
      const deps = testDeps({
        repository: sandbox.repository,
        gh,
        coding,
        review: scriptedReviewAgent([approvingReview()]),
        verifier: async () => failingVerification(),
      })

      const outcome = await workIssue(deps, {
        number: 8,
        title: 'Break something',
        state: 'open',
        labels: ['agent:ready'],
        body: 'Break it.',
      })

      expect(outcome.status).toBe('blocked')
      // Exactly the configured number of rounds, never more.
      expect(coding.rounds).toHaveLength(3)
      expect(gh.labelsOf(8)).toEqual(['agent:blocked'])
      expect(gh.comments[0]?.body).toContain('still failing after 3 round(s)')
    } finally {
      await sandbox.cleanup()
    }
  })

  test('recovers when a later round passes', async () => {
    const sandbox = await createSandbox()
    try {
      const gh = fakeGh({ issues: [issueFixture(9, 'Fix on retry')] })
      const coding = scriptedCodingAgent([
        (task) => write(task, 'retry.ts', 'export const c = 3\n'),
      ])
      let attempts = 0
      const deps = testDeps({
        repository: sandbox.repository,
        gh,
        coding,
        review: scriptedReviewAgent([approvingReview()]),
        verifier: async () => (attempts++ === 0 ? failingVerification() : passingVerification()),
      })

      const outcome = await workIssue(deps, {
        number: 9,
        title: 'Fix on retry',
        state: 'open',
        labels: ['agent:ready'],
        body: 'Retry it.',
      })

      expect(outcome.status).toBe('opened')
      expect(coding.rounds).toHaveLength(2)
      // The second round is told what failed.
      expect(coding.rounds[1]?.verification?.ok).toBe(false)
    } finally {
      await sandbox.cleanup()
    }
  })
})

describe('E — the review asks for changes', () => {
  test('starts a fix round and passes the findings through', async () => {
    const sandbox = await createSandbox()
    try {
      const gh = fakeGh({ issues: [issueFixture(10, 'Needs a fix')] })
      const coding = scriptedCodingAgent([
        (task) => write(task, 'fix.ts', `export const d = ${task.round}\n`),
      ])
      const review = scriptedReviewAgent([
        {
          ok: true,
          review: {
            status: 'request_changes',
            findings: [
              {
                severity: 'medium',
                file: 'fix.ts',
                line: 1,
                description: 'Missing a test.',
                suggested_action: 'Add one.',
                source: 'agent',
                category: 'review',
              },
            ],
            summary: 'Add a test.',
          },
          sessionId: null,
          costUsd: null,
        },
        approvingReview(),
      ])

      const deps = testDeps({ repository: sandbox.repository, gh, coding, review })
      const outcome = await workIssue(deps, {
        number: 10,
        title: 'Needs a fix',
        state: 'open',
        labels: ['agent:ready'],
        body: 'Fix it.',
      })

      expect(outcome.status).toBe('opened')
      expect(coding.rounds).toHaveLength(2)
      expect(coding.rounds[1]?.review?.status).toBe('request_changes')
      expect(coding.rounds[1]?.review?.findings[0]?.description).toBe('Missing a test.')
    } finally {
      await sandbox.cleanup()
    }
  })
})

describe('F — a malformed review', () => {
  test('is never treated as approval', () => {
    expect(extractReview(null, 'Looks good to me, ship it!')).toBeNull()
    expect(extractReview({ status: 'approve' }, null)).toBeNull()
    expect(extractReview(undefined, '```json\n{"status":"yes"}\n```')).toBeNull()

    // A well-formed one still parses, so the check above is not vacuous.
    const valid = extractReview({ status: 'approve', findings: [], summary: 'Fine.' }, null)
    expect(valid?.status).toBe('approve')
  })

  test('blocks the issue rather than opening a pull request', async () => {
    const sandbox = await createSandbox()
    try {
      const gh = fakeGh({ issues: [issueFixture(11, 'Unreviewable')] })
      const deps = testDeps({
        repository: sandbox.repository,
        gh,
        coding: scriptedCodingAgent([(task) => write(task, 'x.ts', 'export const e = 5\n')]),
        review: scriptedReviewAgent([
          { ok: false, reason: 'output was not JSON', detail: 'ship it!' },
        ]),
      })

      const outcome = await workIssue(deps, {
        number: 11,
        title: 'Unreviewable',
        state: 'open',
        labels: ['agent:ready'],
        body: 'Review it.',
      })

      expect(outcome.status).toBe('blocked')
      expect(outcome.pullRequest).toBeNull()
      expect(gh.created).toHaveLength(0)
      expect(gh.labelsOf(11)).toEqual(['agent:blocked'])
    } finally {
      await sandbox.cleanup()
    }
  })
})

describe('G — a high-risk change', () => {
  test('is classified high, dual-reviewed, and merged without a person', async () => {
    const sandbox = await createSandbox()
    try {
      const gh = fakeGh({ issues: [issueFixture(12, 'Touch the loop')] })
      const deps = testDeps({
        repository: sandbox.repository,
        gh,
        coding: scriptedCodingAgent([
          async (task) => {
            await Bun.write(join(task.worktree, 'tooling/loop/policy.ts'), 'export const f = 6\n')
          },
        ]),
        review: scriptedReviewAgent([approvingReview()]),
      })

      const outcome = await workIssue(deps, {
        number: 12,
        title: 'Touch the loop',
        state: 'open',
        labels: ['agent:ready'],
        body: 'Touch it.',
      })

      expect(outcome.risk?.risk).toBe('high')
      // High risk no longer summons a person; it buys two independent reviews
      // and the strongest verification, and then merges like anything else.
      expect(outcome.status).toBe('opened')
      expect(outcome.detail).toContain('auto-merge requested')
      expect(gh.autoMerged).toEqual([100])

      const journal = await readJournal(join(sandbox.repository, '.loop', 'state.json'))
      expect(journal.runs[0]?.risk).toBe('high')
    } finally {
      await sandbox.cleanup()
    }
  })

  test('advance reports the human gate on a green high-risk pull request', async () => {
    const sandbox = await createSandbox()
    try {
      const gh = fakeGh({
        issues: [issueFixture(13, 'High risk')],
        pullRequests: {
          200: {
            number: 200,
            state: 'OPEN',
            url: 'https://github.test/pull/200',
            isDraft: false,
            headRefName: 'agent/issue-13-high-risk',
            headRefOid: 'abc',
            mergeStateStatus: 'BLOCKED',
            reviewDecision: null,
            statusCheckRollup: [{ name: 'CI', status: 'COMPLETED', conclusion: 'SUCCESS' }],
          },
        },
      })

      await Bun.write(
        join(sandbox.repository, '.loop', 'state.json'),
        JSON.stringify({
          version: 1,
          runs: [
            {
              issue: 13,
              branch: 'agent/issue-13-high-risk',
              worktree: join(sandbox.root, 'wt'),
              startedAt: '2026-01-01T00:00:00.000Z',
              updatedAt: '2026-01-01T00:00:00.000Z',
              status: 'awaiting-review',
              fixRounds: 0,
              pullRequest: 200,
              risk: 'high',
              attempts: [],
            },
          ],
        }),
      )

      const deps = testDeps({
        repository: sandbox.repository,
        gh,
        coding: scriptedCodingAgent([]),
        review: scriptedReviewAgent([approvingReview()]),
      })

      const [outcome] = await advance(deps)

      // The philosophy change: high risk is green and waiting on GitHub's own
      // auto-merge, not on a person.
      expect(outcome?.action).toBe('awaiting-merge')
      expect(outcome?.detail).toContain('auto-merge')
      // The runner still has no merge call of its own.
      expect(gh.calls.some((call) => call.startsWith('merge('))).toBe(false)
    } finally {
      await sandbox.cleanup()
    }
  })
})

describe('H — the runner restarts', () => {
  test('resumes the claimed issue rather than claiming a second one', async () => {
    const sandbox = await createSandbox()
    try {
      const gh = fakeGh({
        issues: [issueFixture(20, 'First', ['agent:in-progress']), issueFixture(21, 'Second')],
      })

      await Bun.write(
        join(sandbox.repository, '.loop', 'state.json'),
        JSON.stringify({
          version: 1,
          runs: [
            {
              issue: 20,
              branch: 'agent/issue-20-first',
              worktree: join(sandbox.root, 'wt'),
              startedAt: '2026-01-01T00:00:00.000Z',
              updatedAt: '2026-01-01T00:00:00.000Z',
              status: 'in-progress',
              fixRounds: 0,
              pullRequest: null,
              risk: 'low',
              attempts: [],
            },
          ],
        }),
      )

      const coding = scriptedCodingAgent([
        (task) => write(task, 'resumed.ts', 'export const g = 7\n'),
      ])
      const deps = testDeps({
        repository: sandbox.repository,
        gh,
        coding,
        review: scriptedReviewAgent([approvingReview()]),
      })

      const result = await runOnce(deps)

      // #20 was picked back up; #21 was left alone.
      expect(result.outcomes[0]?.issue).toBe(20)
      expect(gh.labelsOf(21)).toEqual(['agent:ready'])

      // And it resumed at round 2, not round 1: rounds already spent stay spent.
      expect(coding.rounds[0]?.round).toBe(1)
    } finally {
      await sandbox.cleanup()
    }
  })

  test('a resumed run cannot hand itself a fresh retry budget', async () => {
    const sandbox = await createSandbox()
    try {
      const gh = fakeGh({ issues: [issueFixture(22, 'Exhausted', ['agent:in-progress'])] })
      const coding = scriptedCodingAgent([(task) => write(task, 'x.ts', 'export const h = 8\n')])
      const deps = testDeps({
        repository: sandbox.repository,
        gh,
        coding,
        review: scriptedReviewAgent([approvingReview()]),
      })

      // Two rounds already spent on a three-round budget: startRound would be 3.
      const outcome = await workIssue(
        deps,
        { number: 22, title: 'Exhausted', state: 'open', labels: [], body: '' },
        { startRound: 3 },
      )

      expect(outcome.status).toBe('blocked')
      expect(outcome.detail).toContain('already spent')
      expect(coding.rounds).toHaveLength(0)
    } finally {
      await sandbox.cleanup()
    }
  })

  test('leaves a green pull request alone instead of reworking it', async () => {
    const sandbox = await createSandbox()
    try {
      const gh = fakeGh({
        issues: [issueFixture(23, 'Waiting', ['agent:review']), issueFixture(24, 'Next')],
        pullRequests: {
          300: {
            number: 300,
            state: 'OPEN',
            url: 'https://github.test/pull/300',
            isDraft: false,
            headRefName: 'agent/issue-23-waiting',
            headRefOid: 'abc',
            mergeStateStatus: 'BLOCKED',
            reviewDecision: null,
            statusCheckRollup: [{ name: 'CI', status: 'COMPLETED', conclusion: 'SUCCESS' }],
          },
        },
      })

      await Bun.write(
        join(sandbox.repository, '.loop', 'state.json'),
        JSON.stringify({
          version: 1,
          runs: [
            {
              issue: 23,
              branch: 'agent/issue-23-waiting',
              worktree: join(sandbox.root, 'wt'),
              startedAt: '2026-01-01T00:00:00.000Z',
              updatedAt: '2026-01-01T00:00:00.000Z',
              status: 'awaiting-review',
              fixRounds: 0,
              pullRequest: 300,
              risk: 'low',
              attempts: [],
            },
          ],
        }),
      )

      const coding = scriptedCodingAgent([])
      const deps = testDeps({
        repository: sandbox.repository,
        gh,
        coding,
        review: scriptedReviewAgent([approvingReview()]),
      })

      const result = await runOnce(deps)

      expect(result.stopReason).toBe('in-flight')
      expect(result.detail).toContain('checks passing')
      expect(coding.rounds).toHaveLength(0)
      expect(gh.labelsOf(24)).toEqual(['agent:ready'])
    } finally {
      await sandbox.cleanup()
    }
  })

  test('resumes a red pull request with the failing checks as feedback', async () => {
    const sandbox = await createSandbox()
    try {
      const gh = fakeGh({
        issues: [issueFixture(25, 'Red', ['agent:review'])],
        pullRequests: {
          301: {
            number: 301,
            state: 'OPEN',
            url: 'https://github.test/pull/301',
            isDraft: false,
            headRefName: 'agent/issue-25-red',
            headRefOid: 'abc',
            mergeStateStatus: 'BLOCKED',
            reviewDecision: null,
            statusCheckRollup: [{ name: 'Tests', status: 'COMPLETED', conclusion: 'FAILURE' }],
          },
        },
      })

      await Bun.write(
        join(sandbox.repository, '.loop', 'state.json'),
        JSON.stringify({
          version: 1,
          runs: [
            {
              issue: 25,
              branch: 'agent/issue-25-red',
              worktree: join(sandbox.root, 'wt'),
              startedAt: '2026-01-01T00:00:00.000Z',
              updatedAt: '2026-01-01T00:00:00.000Z',
              status: 'awaiting-review',
              fixRounds: 0,
              pullRequest: 301,
              risk: 'low',
              attempts: [],
            },
          ],
        }),
      )

      const coding = scriptedCodingAgent([(task) => write(task, 'red.ts', 'export const i = 9\n')])
      const deps = testDeps({
        repository: sandbox.repository,
        gh,
        coding,
        review: scriptedReviewAgent([approvingReview()]),
      })

      await runOnce(deps)

      expect(coding.rounds).toHaveLength(1)
      expect(coding.rounds[0]?.feedback).toContain('Tests')
      expect(coding.rounds[0]?.round).toBe(1)
    } finally {
      await sandbox.cleanup()
    }
  })
})

describe('I — a second runner', () => {
  test('is refused while the first holds the lock', async () => {
    const root = await mkdtemp(join(tmpdir(), 'newsdeck-lock-'))
    const path = join(root, '.loop', 'runner.lock')

    const first = await acquireLock(path, 'once', {
      pid: 4242,
      host: 'test-host',
      isRunning: () => true,
    })
    expect(first.acquired).toBe(true)

    const second = await acquireLock(path, 'once', {
      pid: 4343,
      host: 'test-host',
      isRunning: () => true,
    })
    expect(second.acquired).toBe(false)
    if (!second.acquired) expect(second.reason).toContain('4242')
  })

  test('takes over a stale lock left by a dead process on the same host', async () => {
    const root = await mkdtemp(join(tmpdir(), 'newsdeck-lock-'))
    const path = join(root, '.loop', 'runner.lock')

    await acquireLock(path, 'once', { pid: 4242, host: 'test-host', isRunning: () => true })
    const taken = await acquireLock(path, 'once', {
      pid: 4343,
      host: 'test-host',
      isRunning: () => false,
    })

    expect(taken.acquired).toBe(true)
  })

  test('refuses a lock from another host rather than guessing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'newsdeck-lock-'))
    const path = join(root, '.loop', 'runner.lock')

    await acquireLock(path, 'once', { pid: 4242, host: 'other-laptop', isRunning: () => true })
    const refused = await acquireLock(path, 'once', {
      pid: 4343,
      host: 'this-laptop',
      isRunning: () => false,
    })

    expect(refused.acquired).toBe(false)
    if (!refused.acquired) expect(refused.reason).toContain('other-laptop')
  })

  test('releasing only ever removes its own lock', async () => {
    const root = await mkdtemp(join(tmpdir(), 'newsdeck-lock-'))
    const path = join(root, '.loop', 'runner.lock')

    const first = await acquireLock(path, 'once', { pid: 1, host: 'h', isRunning: () => false })
    await acquireLock(path, 'once', { pid: 2, host: 'h', isRunning: () => false })

    if (first.acquired) await first.release()
    expect(JSON.parse(await readFile(path, 'utf8')).pid).toBe(2)
  })
})

describe('J — dry run', () => {
  test('reads GitHub and mutates nothing', async () => {
    const sandbox = await createSandbox()
    try {
      const gh = fakeGh({ issues: [issueFixture(30, 'Preview me')] })
      const coding = scriptedCodingAgent([])
      const deps = testDeps({
        repository: sandbox.repository,
        gh,
        coding,
        review: scriptedReviewAgent([approvingReview()]),
      })

      const plan = await planDryRun(deps)

      expect(plan.selected?.number).toBe(30)
      expect(plan.branch).toBe('agent/issue-30-preview-me')
      expect(plan.worktree).toContain('.loop-worktrees')
      expect(plan.order.some((entry) => entry.issue === 30 && entry.eligible)).toBe(true)

      // Nothing was claimed, commented, created, or run.
      expect(gh.labelsOf(30)).toEqual(['agent:ready'])
      expect(gh.comments).toHaveLength(0)
      expect(gh.created).toHaveLength(0)
      expect(coding.rounds).toHaveLength(0)
      expect(gh.calls.every((call) => call.startsWith('issues('))).toBe(true)
    } finally {
      await sandbox.cleanup()
    }
  })
})
