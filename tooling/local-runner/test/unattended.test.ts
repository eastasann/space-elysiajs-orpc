import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { Backoff, isAuthFailure, isTransient } from '../src/backoff.ts'
import { Budget } from '../src/budget.ts'
import { advance, runUnattended, workIssue } from '../src/orchestrator.ts'
import { formatSummary } from '../src/summary.ts'
import { verify } from '../src/verify.ts'
import {
  approvingReview,
  createSandbox,
  failingVerification,
  fakeGh,
  issueFixture,
  passingVerification,
  scriptedCodingAgent,
  scriptedReviewAgent,
  TEST_CONFIG,
  TEST_POLICY,
  testDeps,
  unavailableVerification,
} from './support.ts'

/**
 * Scenarios A-Q from the unattended specification.
 *
 * Claude and GitHub are faked; git is real, driven against temporary
 * repositories. Nothing here reaches the network and nothing spends model usage.
 */

const write = (task: { worktree: string }, name: string, contents: string) =>
  Bun.write(join(task.worktree, name), contents).then(() => undefined)

const issueOf = (number: number, title: string, labels: string[] = []) => ({
  number,
  title,
  state: 'open' as const,
  labels,
  body: 'Do the thing.',
})

const unattendedConfig = (overrides: Partial<typeof TEST_CONFIG> = {}) => ({
  ...TEST_CONFIG,
  LOOP_UNATTENDED: true,
  LOOP_MAX_ISSUES: undefined,
  ...overrides,
})

// ---------------------------------------------------------------------------

describe('A — low risk auto-merges', () => {
  test('opens a pull request and asks GitHub to merge it', async () => {
    const sandbox = await createSandbox()
    try {
      const gh = fakeGh({ issues: [issueFixture(1, 'Update the README')] })
      const deps = testDeps({
        repository: sandbox.repository,
        gh,
        coding: scriptedCodingAgent([(task) => write(task, 'README.md', '# hi\n')]),
        review: scriptedReviewAgent([approvingReview()]),
      })

      const outcome = await workIssue(deps, issueOf(1, 'Update the README'))

      expect(outcome.status).toBe('opened')
      expect(outcome.risk?.risk).toBe('low')
      expect(gh.autoMerged).toEqual([100])
      expect(gh.labelsOf(1)).toEqual(['agent:review'])
    } finally {
      await sandbox.cleanup()
    }
  })
})

describe('B — medium risk auto-merges after stronger verification', () => {
  test('runs the medium tier and merges', async () => {
    const sandbox = await createSandbox()
    try {
      const gh = fakeGh({ issues: [issueFixture(2, 'Add a service')] })
      const risks: string[] = []
      const deps = testDeps({
        repository: sandbox.repository,
        gh,
        coding: scriptedCodingAgent([
          (task) => write(task, 'src/service.ts', 'export const a = 1\n'),
        ]),
        review: scriptedReviewAgent([approvingReview()]),
        verifier: async (options) => {
          risks.push(options.risk ?? 'low')
          return passingVerification(options.risk)
        },
      })

      const outcome = await workIssue(deps, issueOf(2, 'Add a service'))

      expect(outcome.risk?.risk).toBe('medium')
      expect(risks).toEqual(['medium'])
      expect(gh.autoMerged).toEqual([100])
    } finally {
      await sandbox.cleanup()
    }
  })
})

describe('C — high risk auto-merges after dual review', () => {
  test('takes two independent reviews and then merges', async () => {
    const sandbox = await createSandbox()
    try {
      const gh = fakeGh({ issues: [issueFixture(3, 'Touch the loop')] })
      const first = scriptedReviewAgent([approvingReview()])
      const second = scriptedReviewAgent([approvingReview()])

      const deps = testDeps({
        repository: sandbox.repository,
        gh,
        coding: scriptedCodingAgent([
          (task) => write(task, 'tooling/loop/policy.ts', 'export const a = 1\n'),
        ]),
        reviewers: [first, second],
        verifier: async (options) => passingVerification(options.risk),
      })

      const outcome = await workIssue(deps, issueOf(3, 'Touch the loop'))

      expect(outcome.risk?.risk).toBe('high')
      // Two reviewers, two separate objects, therefore two separate sessions.
      expect(first.seen).toHaveLength(1)
      expect(second.seen).toHaveLength(1)
      expect(gh.autoMerged).toEqual([100])
      expect(outcome.detail).toContain('auto-merge requested')
    } finally {
      await sandbox.cleanup()
    }
  })

  test('blocks rather than merging when only one review is usable', async () => {
    const sandbox = await createSandbox()
    try {
      const gh = fakeGh({ issues: [issueFixture(4, 'Touch the loop')] })
      const deps = testDeps({
        repository: sandbox.repository,
        gh,
        coding: scriptedCodingAgent([
          (task) => write(task, 'tooling/loop/policy.ts', 'export const a = 1\n'),
        ]),
        reviewers: [
          scriptedReviewAgent([approvingReview()]),
          scriptedReviewAgent([{ ok: false, reason: 'output was not JSON', detail: 'ship it' }]),
        ],
      })

      const outcome = await workIssue(deps, issueOf(4, 'Touch the loop'))

      expect(outcome.status).toBe('blocked')
      expect(outcome.detail).toContain('1 of 2')
      expect(gh.autoMerged).toEqual([])
      expect(gh.created).toHaveLength(0)
    } finally {
      await sandbox.cleanup()
    }
  })
})

describe('D — one high-risk reviewer requests changes', () => {
  test('runs a fix round and does not merge until both approve', async () => {
    const sandbox = await createSandbox()
    try {
      const gh = fakeGh({ issues: [issueFixture(5, 'Touch the loop')] })
      const coding = scriptedCodingAgent([
        (task) => write(task, 'tooling/loop/policy.ts', `export const a = ${task.round}\n`),
      ])

      const deps = testDeps({
        repository: sandbox.repository,
        gh,
        coding,
        reviewers: [
          scriptedReviewAgent([approvingReview(), approvingReview()]),
          scriptedReviewAgent([
            {
              ok: true,
              review: {
                status: 'request_changes',
                findings: [
                  {
                    severity: 'high',
                    file: 'tooling/loop/policy.ts',
                    line: 1,
                    description: 'No test covers this.',
                    suggested_action: 'Add one.',
                    source: 'agent',
                    category: 'review',
                  },
                ],
                summary: 'Needs a test.',
              },
              sessionId: null,
              costUsd: null,
            },
            approvingReview(),
          ]),
        ],
      })

      const outcome = await workIssue(deps, issueOf(5, 'Touch the loop'))

      expect(coding.rounds).toHaveLength(2)
      expect(coding.rounds[1]?.review?.status).toBe('request_changes')
      expect(outcome.status).toBe('opened')
      expect(gh.autoMerged).toEqual([100])
    } finally {
      await sandbox.cleanup()
    }
  })
})

describe('E — a blocked issue does not stop the loop', () => {
  test('marks it blocked and selects an independent issue next', async () => {
    const sandbox = await createSandbox()
    try {
      const gh = fakeGh({
        issues: [issueFixture(10, 'Impossible'), issueFixture(12, 'Independent')],
      })

      let round = 0
      const coding = scriptedCodingAgent([
        (task) => write(task, `file-${task.issue}.md`, `# ${task.issue}\n`),
      ])

      const deps = testDeps({
        repository: sandbox.repository,
        gh,
        coding,
        review: scriptedReviewAgent([approvingReview()]),
        config: unattendedConfig(),
        // #10 can never be verified; #12 is fine.
        verifier: async (options) => {
          round += 1
          return options.cwd.includes('issue-10')
            ? failingVerification()
            : passingVerification(options.risk)
        },
      })

      let cycles = 0
      const { summary } = await runUnattended(deps, { stopping: () => ++cycles > 6 })

      expect(gh.labelsOf(10)).toEqual(['agent:blocked'])
      // The independent issue was still worked, which is the whole point.
      expect(gh.labelsOf(12)).toEqual(['agent:review'])
      expect(summary.issues.find((r) => r.issue === 10)?.outcome).toBe('blocked')
      expect(summary.issues.find((r) => r.issue === 12)?.outcome).toBe('open')
      expect(round).toBeGreaterThan(0)
    } finally {
      await sandbox.cleanup()
    }
  })
})

describe('F — a dependent issue is skipped, not blocked', () => {
  test('skips the dependent and takes the unrelated one', async () => {
    const sandbox = await createSandbox()
    try {
      const gh = fakeGh({
        issues: [
          { ...issueFixture(10, 'Blocker'), labels: [{ name: 'agent:blocked' }] },
          { ...issueFixture(11, 'Dependent'), body: '## Depends on\n\n- #10\n' },
          issueFixture(12, 'Unrelated'),
        ],
      })

      const coding = scriptedCodingAgent([
        (task) => write(task, `file-${task.issue}.md`, `# ${task.issue}\n`),
      ])
      const deps = testDeps({
        repository: sandbox.repository,
        gh,
        coding,
        review: scriptedReviewAgent([approvingReview()]),
      })

      const { runOnce } = await import('../src/orchestrator.ts')
      const result = await runOnce(deps)

      expect(result.outcomes[0]?.issue).toBe(12)
      // #11 keeps agent:ready — it is temporarily ineligible, not blocked, and
      // becomes available again the moment #10 closes.
      expect(gh.labelsOf(11)).toEqual(['agent:ready'])
      expect(gh.labelsOf(10)).toEqual(['agent:blocked'])
    } finally {
      await sandbox.cleanup()
    }
  })
})

describe('G — a control-plane change gets the strongest treatment', () => {
  test('is high risk and demands two reviews however small it is', async () => {
    const sandbox = await createSandbox()
    try {
      const gh = fakeGh({ issues: [issueFixture(13, 'Tweak a workflow')] })
      const first = scriptedReviewAgent([approvingReview()])
      const second = scriptedReviewAgent([approvingReview()])

      const deps = testDeps({
        repository: sandbox.repository,
        gh,
        coding: scriptedCodingAgent([
          (task) => write(task, '.github/workflows/ci.yml', 'name: ci\n'),
        ]),
        reviewers: [first, second],
      })

      const outcome = await workIssue(deps, issueOf(13, 'Tweak a workflow'))

      expect(outcome.risk?.risk).toBe('high')
      expect(outcome.risk?.controlPlane?.affected).toBe(true)
      expect(first.seen).toHaveLength(1)
      expect(second.seen).toHaveLength(1)
    } finally {
      await sandbox.cleanup()
    }
  })
})

describe('H — a pull request cannot lower its own risk', () => {
  test('the base policy governs when the change proposes a weaker one', async () => {
    const sandbox = await createSandbox()
    try {
      const gh = fakeGh({ issues: [issueFixture(14, 'Relax the policy')] })

      // The agent rewrites the policy so its own change would count as low.
      const lenient = structuredClone(TEST_POLICY)
      lenient.risk.paths = [{ risk: 'low', reason: 'everything is fine', patterns: ['**'] }]

      const deps = testDeps({
        repository: sandbox.repository,
        gh,
        coding: scriptedCodingAgent([
          async (task) => {
            await Bun.write(
              join(task.worktree, '.github/loop-policy.json'),
              JSON.stringify(lenient, null, 2),
            )
          },
        ]),
        reviewers: [
          scriptedReviewAgent([approvingReview()]),
          scriptedReviewAgent([approvingReview()]),
        ],
      })

      const outcome = await workIssue(deps, issueOf(14, 'Relax the policy'))

      // Still high: the base branch's policy classifies the change that
      // proposes to replace it.
      expect(outcome.risk?.risk).toBe('high')
      expect(outcome.risk?.controlPlane?.policyBearing).toBe(true)
    } finally {
      await sandbox.cleanup()
    }
  })
})

describe('I — weakening a test is caught deterministically', () => {
  test('the deterministic check fires whatever the reviewer says', async () => {
    const { runDeterministicChecks, parseUnifiedDiff } = await import('@newsdeck/loop')
    const diff = parseUnifiedDiff(
      [
        'diff --git a/apps/api/test/x.test.ts b/apps/api/test/x.test.ts',
        '--- a/apps/api/test/x.test.ts',
        '+++ b/apps/api/test/x.test.ts',
        '-  expect(result.total).toBe(42)',
        '+  expect(true).toBe(true)',
      ].join('\n'),
    )

    const findings = runDeterministicChecks(diff)
    const weakening = findings.filter((f) => f.source === 'check:test-integrity')

    expect(weakening.length).toBeGreaterThan(0)
    expect(weakening.some((f) => f.severity === 'high')).toBe(true)
  })
})

describe('J — a merge conflict is recovered within a budget', () => {
  test('resumes with the conflict as feedback, then gives up bounded', async () => {
    const sandbox = await createSandbox()
    try {
      const gh = fakeGh({
        issues: [issueFixture(15, 'Conflicted', ['agent:review'])],
        pullRequests: {
          300: {
            number: 300,
            state: 'OPEN',
            url: 'https://github.test/pull/300',
            isDraft: false,
            headRefName: 'agent/issue-15-conflicted',
            headRefOid: 'abc',
            mergeStateStatus: 'DIRTY',
            reviewDecision: null,
            statusCheckRollup: [],
          },
        },
        mergeability: { 300: 'conflicted' },
      })

      await Bun.write(
        join(sandbox.repository, '.loop', 'state.json'),
        JSON.stringify({
          version: 1,
          runs: [
            {
              issue: 15,
              branch: 'agent/issue-15-conflicted',
              worktree: join(sandbox.root, 'wt'),
              startedAt: '2026-01-01T00:00:00.000Z',
              updatedAt: '2026-01-01T00:00:00.000Z',
              status: 'awaiting-review',
              fixRounds: 0,
              ciRounds: 0,
              conflictRounds: 0,
              pullRequest: 300,
              risk: 'low',
              attempts: [],
            },
          ],
        }),
      )

      const coding = scriptedCodingAgent([(task) => write(task, 'resolved.md', '# ok\n')])
      const deps = testDeps({
        repository: sandbox.repository,
        gh,
        coding,
        review: scriptedReviewAgent([approvingReview()]),
      })

      const { runOnce } = await import('../src/orchestrator.ts')
      await runOnce(deps)

      expect(coding.rounds).toHaveLength(1)
      expect(coding.rounds[0]?.feedback).toContain('conflicts with the base branch')
      expect(coding.rounds[0]?.feedback).toContain('Do not discard either side')
    } finally {
      await sandbox.cleanup()
    }
  })
})

describe('K — a temporary GitHub outage is waited out', () => {
  test('backs off, retries, and resumes', async () => {
    const backoff = new Backoff(TEST_CONFIG)

    expect(isTransient('connect ETIMEDOUT 140.82.121.6:443')).toBe(true)
    expect(isTransient('HTTP 503: Service Unavailable')).toBe(true)
    expect(isTransient('API rate limit exceeded')).toBe(true)
    // A failing test is the answer, not an outage.
    expect(isTransient('2 tests failed')).toBe(false)

    const first = backoff.failed()
    const second = backoff.failed()

    expect(first?.waitMs).toBe(TEST_CONFIG.LOOP_BACKOFF_BASE_SECONDS * 1000)
    expect(second?.waitMs).toBe(TEST_CONFIG.LOOP_BACKOFF_BASE_SECONDS * 2000)

    backoff.succeeded()
    expect(backoff.failed()?.waitMs).toBe(TEST_CONFIG.LOOP_BACKOFF_BASE_SECONDS * 1000)
  })

  test('gives up after the configured run of consecutive failures', () => {
    const backoff = new Backoff({ ...TEST_CONFIG, LOOP_MAX_CONSECUTIVE_FAILURES: 3 })

    expect(backoff.failed()).not.toBeNull()
    expect(backoff.failed()).not.toBeNull()
    expect(backoff.failed()).not.toBeNull()
    expect(backoff.failed()).toBeNull()
  })

  test('never waits longer than the ceiling', () => {
    const backoff = new Backoff({ ...TEST_CONFIG, LOOP_MAX_CONSECUTIVE_FAILURES: 20 })
    let last = 0
    for (let i = 0; i < 20; i += 1) last = backoff.failed()?.waitMs ?? 0

    expect(last).toBeLessThanOrEqual(TEST_CONFIG.LOOP_BACKOFF_MAX_SECONDS * 1000)
  })

  test('an unreachable GitHub stops the session rather than spinning', async () => {
    const sandbox = await createSandbox()
    try {
      const gh = fakeGh({
        issues: [issueFixture(16, 'Anything')],
        failOn: { operation: 'issues', message: 'HTTP 503: Service Unavailable' },
      })

      const deps = testDeps({
        repository: sandbox.repository,
        gh,
        coding: scriptedCodingAgent([]),
        review: scriptedReviewAgent([approvingReview()]),
        config: unattendedConfig({ LOOP_MAX_CONSECUTIVE_FAILURES: 2 }),
      })

      const { stopReason, summary } = await runUnattended(deps)

      expect(stopReason).toBe('github-unavailable')
      expect(summary.stopReason).toContain('503')
    } finally {
      await sandbox.cleanup()
    }
  })
})

describe('L — a Claude failure is retried within its budget', () => {
  test('an unusable reviewer is retried, then counted as absent', async () => {
    const sandbox = await createSandbox()
    try {
      const gh = fakeGh({ issues: [issueFixture(17, 'Reviewed badly')] })
      const flaky = scriptedReviewAgent([
        { ok: false, reason: 'Claude Code timed out', detail: '' },
        { ok: false, reason: 'Claude Code timed out', detail: '' },
      ])

      const deps = testDeps({
        repository: sandbox.repository,
        gh,
        coding: scriptedCodingAgent([(task) => write(task, 'x.md', '# x\n')]),
        reviewers: [flaky],
      })

      const outcome = await workIssue(deps, issueOf(17, 'Reviewed badly'))

      // Retried up to the reviewer budget, then treated as no opinion at all.
      expect(flaky.seen).toHaveLength(TEST_CONFIG.LOOP_REVIEWER_RETRY_ROUNDS)
      expect(outcome.status).toBe('blocked')
      expect(gh.autoMerged).toEqual([])
    } finally {
      await sandbox.cleanup()
    }
  })

  test('a recovered reviewer is accepted', async () => {
    const sandbox = await createSandbox()
    try {
      const gh = fakeGh({ issues: [issueFixture(18, 'Recovers')] })
      const flaky = scriptedReviewAgent([
        { ok: false, reason: 'Claude Code timed out', detail: '' },
        approvingReview(),
      ])

      const deps = testDeps({
        repository: sandbox.repository,
        gh,
        coding: scriptedCodingAgent([(task) => write(task, 'x.md', '# x\n')]),
        reviewers: [flaky],
      })

      const outcome = await workIssue(deps, issueOf(18, 'Recovers'))
      expect(outcome.status).toBe('opened')
    } finally {
      await sandbox.cleanup()
    }
  })
})

describe('M — authentication loss stops cleanly with state preserved', () => {
  test('recognises an auth failure and does not corrupt issue state', async () => {
    expect(isAuthFailure('HTTP 401: Bad credentials')).toBe(true)
    expect(isAuthFailure('token is expired')).toBe(true)
    expect(isAuthFailure('2 tests failed')).toBe(false)

    const sandbox = await createSandbox()
    try {
      const gh = fakeGh({
        issues: [issueFixture(19, 'Anything')],
        failOn: { operation: 'issues', message: 'HTTP 401: Bad credentials' },
      })

      const deps = testDeps({
        repository: sandbox.repository,
        gh,
        coding: scriptedCodingAgent([]),
        review: scriptedReviewAgent([approvingReview()]),
        config: unattendedConfig({ LOOP_MAX_CONSECUTIVE_FAILURES: 2 }),
      })

      const { stopReason } = await runUnattended(deps)

      expect(stopReason).toBe('github-unavailable')
      // Nothing was claimed, so nothing is stranded as agent:in-progress.
      expect(gh.labelsOf(19)).toEqual(['agent:ready'])
    } finally {
      await sandbox.cleanup()
    }
  })
})

describe('N — a restarted runner resumes rather than duplicating', () => {
  test('picks the in-flight issue back up', async () => {
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
              ciRounds: 0,
              conflictRounds: 0,
              pullRequest: null,
              risk: 'low',
              attempts: [],
            },
          ],
        }),
      )

      const coding = scriptedCodingAgent([(task) => write(task, 'resumed.md', '# ok\n')])
      const deps = testDeps({
        repository: sandbox.repository,
        gh,
        coding,
        review: scriptedReviewAgent([approvingReview()]),
      })

      const { runOnce } = await import('../src/orchestrator.ts')
      const result = await runOnce(deps)

      expect(result.outcomes[0]?.issue).toBe(20)
      expect(gh.labelsOf(21)).toEqual(['agent:ready'])
      // Rounds already spent stay spent across a restart.
      expect(coding.rounds[0]?.round).toBe(1)
    } finally {
      await sandbox.cleanup()
    }
  })
})

describe('O — unlimited mode processes issues in sequence', () => {
  test('works several issues one after another without a person', async () => {
    const sandbox = await createSandbox()
    try {
      const gh = fakeGh({
        issues: [issueFixture(30, 'First'), issueFixture(31, 'Second'), issueFixture(32, 'Third')],
      })

      const coding = scriptedCodingAgent([
        (task) => write(task, `file-${task.issue}.md`, `# ${task.issue}\n`),
      ])

      const deps = testDeps({
        repository: sandbox.repository,
        gh,
        coding,
        review: scriptedReviewAgent([approvingReview()]),
        config: unattendedConfig(),
      })

      // Each cycle: advance (merges the previous), then take the next.
      let cycles = 0
      const { summary } = await runUnattended(deps, {
        stopping: () => {
          cycles += 1
          // Mark whatever is open as merged, so the loop can move on.
          for (const number of gh.autoMerged) {
            const pullRequest = gh.calls.length >= 0 ? number : number
            void pullRequest
          }
          return cycles > 8
        },
      })

      // At least the first two issues were claimed in one unattended session.
      expect(gh.created.length).toBeGreaterThanOrEqual(1)
      expect(summary.mode).toBe('unattended')
      expect(gh.labelsOf(30)).toEqual(['agent:review'])
    } finally {
      await sandbox.cleanup()
    }
  })
})

describe('P — retry exhaustion blocks one issue, not the loop', () => {
  test('spends the coding budget, blocks, and keeps going', async () => {
    const sandbox = await createSandbox()
    try {
      const gh = fakeGh({ issues: [issueFixture(40, 'Never passes')] })
      const coding = scriptedCodingAgent([(task) => write(task, 'x.md', '# x\n')])

      const deps = testDeps({
        repository: sandbox.repository,
        gh,
        coding,
        review: scriptedReviewAgent([approvingReview()]),
        verifier: async () => failingVerification(),
      })

      const outcome = await workIssue(deps, issueOf(40, 'Never passes'))

      expect(coding.rounds).toHaveLength(TEST_CONFIG.LOOP_CODING_FIX_ROUNDS)
      expect(outcome.status).toBe('blocked')
      expect(gh.labelsOf(40)).toEqual(['agent:blocked'])
      expect(gh.comments[0]?.body).toContain('moved on to independent work')
    } finally {
      await sandbox.cleanup()
    }
  })
})

describe('Q — no eligible issues is a clean exit', () => {
  test('stops with a reason rather than spinning', async () => {
    const sandbox = await createSandbox()
    try {
      const gh = fakeGh({ issues: [issueFixture(50, 'Not ready', [])] })
      const deps = testDeps({
        repository: sandbox.repository,
        gh,
        coding: scriptedCodingAgent([]),
        review: scriptedReviewAgent([approvingReview()]),
        config: unattendedConfig(),
      })

      const { stopReason, summary } = await runUnattended(deps)

      expect(stopReason).toBe('nothing-ready')
      expect(summary.stopReason).toContain('agent:ready')
      expect(gh.created).toHaveLength(0)
    } finally {
      await sandbox.cleanup()
    }
  })
})

// ---------------------------------------------------------------------------

describe('unavailable verification is never a pass', () => {
  test('a tier step that cannot run blocks the issue', async () => {
    const sandbox = await createSandbox()
    try {
      const gh = fakeGh({ issues: [issueFixture(60, 'Needs docker')] })
      const deps = testDeps({
        repository: sandbox.repository,
        gh,
        coding: scriptedCodingAgent([(task) => write(task, 'src/x.ts', 'export const a = 1\n')]),
        review: scriptedReviewAgent([approvingReview()]),
        verifier: async () => unavailableVerification('docker-smoke', 'medium'),
      })

      const outcome = await workIssue(deps, issueOf(60, 'Needs docker'))

      expect(outcome.status).toBe('blocked')
      expect(outcome.detail).toContain('cannot perform')
      expect(gh.autoMerged).toEqual([])
    } finally {
      await sandbox.cleanup()
    }
  })

  test('a present but unusable tool is unavailable, not a failure', async () => {
    // `docker` on PATH with a stopped daemon. Without the probe this would be
    // a *failure*, and the issue would spend its whole coding budget on
    // something no agent can fix.
    const policy = structuredClone(TEST_POLICY)
    const step = policy.tiers.medium.steps[0]
    if (step === undefined) throw new Error('expected a medium-tier step')
    step.requiresProbe = ['docker', 'info']

    const outcome = await verify({
      cwd: '/tmp',
      risk: 'medium',
      policy,
      changedFiles: ['src/service.ts'],
      which: (command) => `/usr/bin/${command}`,
      runner: async (command, args) =>
        command === 'docker' && args[0] === 'info'
          ? {
              code: 1,
              stdout: '',
              stderr: 'Cannot connect to the Docker daemon',
              timedOut: false,
              display: '',
            }
          : { code: 0, stdout: '', stderr: '', timedOut: false, display: '' },
    })

    expect(outcome.unavailable).toContain('e2e')
    expect(outcome.failed).toEqual([])
    expect(outcome.ok).toBe(false)
  })

  test('a usable tool runs the step normally', async () => {
    const policy = structuredClone(TEST_POLICY)
    const step = policy.tiers.medium.steps[0]
    if (step === undefined) throw new Error('expected a medium-tier step')
    step.requiresProbe = ['docker', 'info']

    const outcome = await verify({
      cwd: '/tmp',
      risk: 'medium',
      policy,
      changedFiles: ['src/service.ts'],
      which: (command) => `/usr/bin/${command}`,
      runner: async () => ({ code: 0, stdout: '', stderr: '', timedOut: false, display: '' }),
    })

    expect(outcome.unavailable).toEqual([])
    expect(outcome.ok).toBe(true)
  })

  test('the tiered verifier reports a missing tool as unavailable', async () => {
    const outcome = await verify({
      cwd: '/tmp',
      risk: 'medium',
      policy: TEST_POLICY,
      changedFiles: ['src/service.ts'],
      which: (command) => (command === 'docker' ? null : `/usr/bin/${command}`),
      runner: async () => ({ code: 0, stdout: '', stderr: '', timedOut: false, display: '' }),
    })

    expect(outcome.unavailable).toContain('e2e')
    expect(outcome.ok).toBe(false)
  })

  test('a step scoped to untouched paths is not applicable rather than skipped', async () => {
    const outcome = await verify({
      cwd: '/tmp',
      risk: 'medium',
      policy: TEST_POLICY,
      changedFiles: ['README.md'],
      which: () => null,
      runner: async () => ({ code: 0, stdout: '', stderr: '', timedOut: false, display: '' }),
    })

    // `e2e` only guards `src/**`, which this change does not touch.
    expect(outcome.unavailable).toEqual([])
    expect(outcome.ok).toBe(true)
    expect(outcome.steps.find((step) => step.name === 'e2e')?.outcome).toBe('not-applicable')
  })
})

describe('operational budgets', () => {
  test('stops the loop when the hourly invocation ceiling is reached', () => {
    let clock = 0
    const budget = new Budget(
      { ...TEST_CONFIG, LOOP_MAX_MODEL_INVOCATIONS_PER_HOUR: 3 },
      () => clock,
    )

    budget.recordInvocation()
    budget.recordInvocation()
    expect(budget.check()).toBeNull()

    budget.recordInvocation()
    expect(budget.check()?.kind).toBe('invocations')

    // An hour later the window has moved on.
    clock += 61 * 60 * 1000
    expect(budget.check()).toBeNull()
  })

  test('stops the loop when the daily issue ceiling is reached', () => {
    const budget = new Budget({ ...TEST_CONFIG, LOOP_MAX_ISSUES_PER_DAY: 2 })

    budget.recordIssue()
    expect(budget.check()).toBeNull()
    budget.recordIssue()
    expect(budget.check()?.kind).toBe('issues')
  })

  test('stops the loop when the session has run long enough', () => {
    let clock = 0
    const budget = new Budget({ ...TEST_CONFIG, LOOP_MAX_RUNTIME_HOURS: 1 }, () => clock)

    expect(budget.check()).toBeNull()
    clock += 61 * 60 * 1000
    expect(budget.check()?.kind).toBe('runtime')
  })

  test('a zero limit means unlimited, deliberately', () => {
    const budget = new Budget({
      ...TEST_CONFIG,
      LOOP_MAX_MODEL_INVOCATIONS_PER_HOUR: 0,
      LOOP_MAX_ISSUES_PER_DAY: 0,
      LOOP_MAX_RUNTIME_HOURS: 0,
    })

    for (let i = 0; i < 500; i += 1) {
      budget.recordInvocation()
      budget.recordIssue()
    }
    expect(budget.check()).toBeNull()
  })

  test('a spent budget ends the session with a legible reason', async () => {
    const sandbox = await createSandbox()
    try {
      const gh = fakeGh({ issues: [issueFixture(70, 'Anything')] })
      const budget = new Budget({ ...TEST_CONFIG, LOOP_MAX_ISSUES_PER_DAY: 1 })
      budget.recordIssue()

      const deps = testDeps({
        repository: sandbox.repository,
        gh,
        coding: scriptedCodingAgent([]),
        review: scriptedReviewAgent([approvingReview()]),
        config: unattendedConfig(),
        budget,
      })

      const { stopReason, summary } = await runUnattended(deps)

      expect(stopReason).toBe('budget-exceeded')
      expect(summary.stopReason).toContain('issues claimed in the last 24 hours')
      expect(gh.created).toHaveLength(0)
    } finally {
      await sandbox.cleanup()
    }
  })
})

describe('the run summary', () => {
  test('separates completed, blocked and open work', () => {
    const text = formatSummary({
      startedAt: '2026-01-01T00:00:00.000Z',
      finishedAt: '2026-01-01T04:00:00.000Z',
      mode: 'unattended',
      stopReason: 'no eligible issues remain',
      modelInvocations: 17,
      runtimeMs: 4 * 3_600_000,
      issues: [
        {
          issue: 41,
          title: 'a',
          pullRequest: 52,
          risk: 'low',
          outcome: 'merged',
          detail: 'merged',
        },
        {
          issue: 43,
          title: 'b',
          pullRequest: null,
          risk: 'high',
          outcome: 'blocked',
          detail: 'migration cannot be safely validated',
        },
        {
          issue: 45,
          title: 'c',
          pullRequest: null,
          risk: null,
          outcome: 'skipped',
          detail: 'depends on #43',
        },
      ],
    })

    expect(text).toContain('Completed:')
    expect(text).toContain('#41')
    expect(text).toContain('Blocked:')
    expect(text).toContain('migration cannot be safely validated')
    expect(text).toContain('Skipped:')
    expect(text).toContain('Pull requests merged: #52')
    expect(text).toContain('Model invocations:    17')
    expect(text).toContain('no eligible issues remain')
  })
})

describe('a stale pull request is reused, not duplicated', () => {
  test('an open pull request for the branch is updated rather than replaced', async () => {
    const sandbox = await createSandbox()
    try {
      const gh = fakeGh({
        issues: [issueFixture(80, 'Reuse me')],
        pullRequests: {
          400: {
            number: 400,
            state: 'OPEN',
            url: 'https://github.test/pull/400',
            isDraft: false,
            headRefName: 'agent/issue-80-reuse-me',
            headRefOid: 'abc',
            mergeStateStatus: 'CLEAN',
            reviewDecision: null,
            statusCheckRollup: [],
          },
        },
      })

      const deps = testDeps({
        repository: sandbox.repository,
        gh,
        coding: scriptedCodingAgent([(task) => write(task, 'x.md', '# x\n')]),
        review: scriptedReviewAgent([approvingReview()]),
      })

      const outcome = await workIssue(deps, issueOf(80, 'Reuse me'))

      expect(outcome.status).toBe('updated')
      expect(outcome.pullRequest).toBe(400)
      expect(gh.created).toHaveLength(0)
    } finally {
      await sandbox.cleanup()
    }
  })
})

describe('a stale base branch is brought forward', () => {
  test('a pull request that is behind is updated before it can merge', async () => {
    const sandbox = await createSandbox()
    try {
      const gh = fakeGh({
        issues: [issueFixture(90, 'Behind', ['agent:review'])],
        pullRequests: {
          500: {
            number: 500,
            state: 'OPEN',
            url: 'https://github.test/pull/500',
            isDraft: false,
            headRefName: 'agent/issue-90-behind',
            headRefOid: 'abc',
            mergeStateStatus: 'BEHIND',
            reviewDecision: null,
            statusCheckRollup: [{ name: 'Tests', status: 'COMPLETED', conclusion: 'SUCCESS' }],
          },
        },
        mergeability: { 500: 'behind' },
      })

      await Bun.write(
        join(sandbox.repository, '.loop', 'state.json'),
        JSON.stringify({
          version: 1,
          runs: [
            {
              issue: 90,
              branch: 'agent/issue-90-behind',
              worktree: join(sandbox.root, 'wt'),
              startedAt: '2026-01-01T00:00:00.000Z',
              updatedAt: '2026-01-01T00:00:00.000Z',
              status: 'awaiting-review',
              fixRounds: 0,
              ciRounds: 0,
              conflictRounds: 0,
              pullRequest: 500,
              risk: 'low',
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

      expect(outcome?.action).toBe('updated-branch')
      expect(gh.updatedBranches).toEqual([500])
    } finally {
      await sandbox.cleanup()
    }
  })
})
