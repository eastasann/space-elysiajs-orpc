import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type LoopPolicy, parsePolicy, type RiskLevel } from '@newsdeck/loop'
import type { CodingAgent, CodingTask, ReviewAgent, ReviewTask } from '../src/agent.ts'
import type { RunnerConfig } from '../src/config.ts'
import { run } from '../src/exec.ts'
import type {
  CreatePullRequestInput,
  GhIssue,
  GhPullRequest,
  GitHubAdapter,
  Mergeability,
} from '../src/github.ts'
import { nullLog } from '../src/logs.ts'
import type { RunnerDeps } from '../src/orchestrator.ts'
import type { VerificationOutcome } from '../src/verify.ts'

/**
 * Test doubles.
 *
 * Claude and GitHub are both faked: the suite must be runnable offline, in CI,
 * by anyone, without an Anthropic credential and without spending model usage.
 * Git is *not* faked — the worktree, branch and push behaviour is most of what
 * could go wrong, so the tests drive real repositories in a temporary directory.
 */

export const TEST_POLICY: LoopPolicy = parsePolicy({
  retry: {
    maxReviewAttempts: 3,
    codingFixRounds: 3,
    reviewFixRounds: 3,
    ciFixRounds: 3,
    reviewerRetryRounds: 2,
    conflictRounds: 2,
  },
  risk: {
    default: 'low',
    paths: [
      { risk: 'high', reason: 'loop control plane', patterns: ['.github/**', 'tooling/loop/**'] },
      { risk: 'medium', reason: 'application code', patterns: ['src/**'] },
    ],
    escalations: {
      maxChangedFiles: 40,
      maxDeletedLines: 600,
      destructiveMigrationGlobs: ['**/migrations/**'],
      publicContractGlobs: ['packages/contracts/**'],
    },
  },
  tiers: {
    low: {
      reviewers: 1,
      steps: [{ name: 'test', command: 'bun', args: ['run', 'test'], timeoutMinutes: 5 }],
    },
    medium: {
      inherits: 'low',
      reviewers: 1,
      steps: [
        {
          name: 'e2e',
          command: 'bun',
          args: ['run', 'test:e2e'],
          whenChanged: ['src/**'],
          requires: 'docker',
          timeoutMinutes: 5,
        },
      ],
    },
    high: {
      inherits: 'medium',
      reviewers: 2,
      steps: [
        {
          name: 'loop-self-test',
          command: 'bun',
          args: ['run', 'test'],
          whenChanged: ['.github/**', 'tooling/loop/**'],
          timeoutMinutes: 5,
        },
      ],
    },
  },
  controlPlane: {
    patterns: ['.github/workflows/**', 'tooling/loop/**'],
    alwaysPolicy: ['.github/loop-policy.json'],
    policySignals: ['auto[- ]?merge', 'required check', 'must never'],
  },
  review: { blockingSeverity: 'high' },
  requiredChecks: ['Tests'],
})

export const TEST_CONFIG: RunnerConfig = {
  LOOP_UNATTENDED: false,
  LOOP_MAX_ISSUES: 1,
  LOOP_CODING_FIX_ROUNDS: 3,
  LOOP_REVIEW_FIX_ROUNDS: 3,
  LOOP_CI_FIX_ROUNDS: 3,
  LOOP_REVIEWER_RETRY_ROUNDS: 2,
  LOOP_CONFLICT_ROUNDS: 2,
  LOOP_WORKTREE_ROOT: '../.loop-worktrees',
  LOOP_POLL_INTERVAL_SECONDS: 60,
  LOOP_CI_TIMEOUT_MINUTES: 30,
  LOOP_AGENT_TIMEOUT_MINUTES: 45,
  LOOP_AGENT_MODEL: '',
  LOOP_REVIEWER_B_MODEL: '',
  LOOP_MAX_MODEL_INVOCATIONS_PER_HOUR: 60,
  LOOP_MAX_ISSUES_PER_DAY: 20,
  LOOP_MAX_RUNTIME_HOURS: 12,
  LOOP_MAX_CONSECUTIVE_FAILURES: 8,
  LOOP_BACKOFF_BASE_SECONDS: 30,
  LOOP_BACKOFF_MAX_SECONDS: 900,
}

export interface Sandbox {
  /** A working clone with `origin` pointing at a bare repository. */
  repository: string
  origin: string
  root: string
  cleanup(): Promise<void>
}

export async function createSandbox(): Promise<Sandbox> {
  const root = await mkdtemp(join(tmpdir(), 'newsdeck-runner-'))
  const origin = join(root, 'origin.git')
  const repository = join(root, 'work')

  await must(run('git', ['init', '--bare', '--initial-branch=main', origin]))
  await must(run('git', ['clone', origin, repository]))
  await must(run('git', ['config', 'user.email', 'runner@example.test'], { cwd: repository }))
  await must(run('git', ['config', 'user.name', 'Runner Test'], { cwd: repository }))

  await writeFile(join(repository, 'README.md'), '# fixture\n', 'utf8')
  await must(run('git', ['add', '.'], { cwd: repository }))
  await must(run('git', ['commit', '-m', 'initial'], { cwd: repository }))
  await must(run('git', ['push', '-u', 'origin', 'main'], { cwd: repository }))

  return {
    root,
    origin,
    repository,
    cleanup: () => rm(root, { recursive: true, force: true }),
  }
}

async function must(promise: Promise<{ code: number; stderr: string }>): Promise<void> {
  const result = await promise
  if (result.code !== 0) throw new Error(`git setup failed: ${result.stderr}`)
}

export interface FakeGhOptions {
  issues?: GhIssue[]
  pullRequests?: Record<number, GhPullRequest>
  /** Merge state per pull request. Defaults to `clean`. */
  mergeability?: Record<number, Mergeability>
  /** Throw on the named operation, to exercise recovery paths. */
  failOn?: { operation: string; message: string }
}

export interface FakeGh extends GitHubAdapter {
  readonly calls: string[]
  readonly comments: Array<{ issue: number; body: string }>
  readonly created: CreatePullRequestInput[]
  /** Pull requests the runner asked GitHub to auto-merge. */
  readonly autoMerged: number[]
  readonly updatedBranches: number[]
  labelsOf(issue: number): string[]
}

export function fakeGh(options: FakeGhOptions = {}): FakeGh {
  const issues = options.issues ?? []
  const pullRequests = options.pullRequests ?? {}
  const calls: string[] = []
  const comments: Array<{ issue: number; body: string }> = []
  const created: CreatePullRequestInput[] = []
  const autoMerged: number[] = []
  const updatedBranches: number[] = []
  const mergeStates = options.mergeability ?? {}
  let nextNumber = 100

  const guard = (operation: string) => {
    if (options.failOn?.operation === operation) throw new Error(options.failOn.message)
  }

  const find = (number: number): GhIssue => {
    const issue = issues.find((candidate) => candidate.number === number)
    if (issue === undefined) throw new Error(`No fixture issue #${number}`)
    return issue
  }

  return {
    calls,
    comments,
    created,
    autoMerged,
    updatedBranches,
    labelsOf: (issue) => find(issue).labels.map((label) => label.name),

    async issues(labels) {
      calls.push(`issues(${labels.join(',')})`)
      guard('issues')
      return issues.filter(
        (issue) =>
          issue.state === 'open' &&
          labels.every((label) => issue.labels.some((existing) => existing.name === label)),
      )
    },

    async issue(number) {
      calls.push(`issue(${number})`)
      return find(number)
    },

    async addLabels(number, labels) {
      calls.push(`addLabels(${number},${labels.join(',')})`)
      const issue = find(number)
      for (const label of labels) {
        if (!issue.labels.some((existing) => existing.name === label)) {
          issue.labels.push({ name: label })
        }
      }
    },

    async removeLabel(number, label) {
      calls.push(`removeLabel(${number},${label})`)
      const issue = find(number)
      issue.labels = issue.labels.filter((existing) => existing.name !== label)
    },

    async comment(number, body) {
      calls.push(`comment(${number})`)
      comments.push({ issue: number, body })
    },

    async createPullRequest(input) {
      calls.push(`createPullRequest(${input.head})`)
      created.push(input)
      const number = nextNumber++
      pullRequests[number] = {
        number,
        state: 'OPEN',
        url: `https://github.test/pull/${number}`,
        isDraft: false,
        headRefName: input.head,
        headRefOid: 'deadbeef',
        mergeStateStatus: 'BLOCKED',
        reviewDecision: null,
        statusCheckRollup: [],
      }
      return number
    },

    async pullRequest(number) {
      calls.push(`pullRequest(${number})`)
      const pullRequest = pullRequests[number]
      if (pullRequest === undefined) throw new Error(`No fixture pull request #${number}`)
      return pullRequest
    },

    async pullRequestForBranch(branch) {
      calls.push(`pullRequestForBranch(${branch})`)
      return Object.values(pullRequests).find((pr) => pr.headRefName === branch) ?? null
    },

    async pullRequestComments(number) {
      calls.push(`pullRequestComments(${number})`)
      return comments.filter((comment) => comment.issue === number).map((comment) => comment.body)
    },

    async pullRequestDiff(number) {
      calls.push(`pullRequestDiff(${number})`)
      return ''
    },

    async enableAutoMerge(number) {
      calls.push(`enableAutoMerge(${number})`)
      guard('enableAutoMerge')
      autoMerged.push(number)
    },

    async updateBranch(number) {
      calls.push(`updateBranch(${number})`)
      guard('updateBranch')
      updatedBranches.push(number)
      mergeStates[number] = 'clean'
    },

    async rerunFailedChecks(number) {
      calls.push(`rerunFailedChecks(${number})`)
    },

    async mergeability(number) {
      calls.push(`mergeability(${number})`)
      return mergeStates[number] ?? 'clean'
    },
  }
}

export function issueFixture(
  number: number,
  title: string,
  labels: string[] = ['agent:ready'],
  body = 'Do the thing.',
): GhIssue {
  return { number, title, body, state: 'open', labels: labels.map((name) => ({ name })) }
}

/** A coding agent that writes a file, so the run produces a real diff. */
export function scriptedCodingAgent(
  steps: Array<(task: CodingTask) => Promise<void> | void>,
): CodingAgent & { readonly rounds: CodingTask[] } {
  const rounds: CodingTask[] = []

  return {
    name: 'scripted',
    rounds,
    async implement(task) {
      rounds.push(task)
      const step = steps[Math.min(task.round, steps.length - 1)]
      await step?.(task)
      return { ok: true, summary: `round ${task.round}`, sessionId: null, costUsd: null }
    },
  }
}

export function scriptedReviewAgent(
  results: Array<Awaited<ReturnType<ReviewAgent['review']>>>,
): ReviewAgent & { readonly seen: ReviewTask[] } {
  const seen: ReviewTask[] = []

  return {
    name: 'scripted-review',
    seen,
    async review(task) {
      seen.push(task)
      const result = results[Math.min(seen.length - 1, results.length - 1)]
      if (result === undefined) throw new Error('No scripted review result')
      return result
    },
  }
}

export function approvingReview(): Awaited<ReturnType<ReviewAgent['review']>> {
  return {
    ok: true,
    review: { status: 'approve', findings: [], summary: 'Looks right.' },
    sessionId: null,
    costUsd: null,
  }
}

export function passingVerification(risk: RiskLevel = 'low'): VerificationOutcome {
  return {
    ok: true,
    risk,
    steps: [{ name: 'test', outcome: 'passed', ok: true, durationMs: 1, output: '' }],
    firstFailure: null,
    unavailable: [],
    failed: [],
  }
}

export function failingVerification(risk: RiskLevel = 'low'): VerificationOutcome {
  const step = {
    name: 'test',
    outcome: 'failed' as const,
    ok: false,
    durationMs: 1,
    output: '1 test failed',
  }
  return { ok: false, risk, steps: [step], firstFailure: step, unavailable: [], failed: ['test'] }
}

/** A tier step that could not run. Never a pass. */
export function unavailableVerification(
  name = 'docker-smoke',
  risk: RiskLevel = 'high',
): VerificationOutcome {
  return {
    ok: false,
    risk,
    steps: [
      { name, outcome: 'unavailable', ok: true, durationMs: 0, output: '`docker` is not on PATH.' },
    ],
    firstFailure: null,
    unavailable: [name],
    failed: [],
  }
}

export interface DepsOverrides extends Partial<RunnerDeps> {
  repository: string
  gh: GitHubAdapter
  coding: CodingAgent
  /** Convenience: one reviewer used for every pass the tier requires. */
  review?: ReviewAgent
}

export function testDeps(overrides: DepsOverrides): RunnerDeps {
  const { review, ...rest } = overrides
  const reviewers = overrides.reviewers ?? (review === undefined ? [] : [review, review])

  return {
    config: TEST_CONFIG,
    policy: TEST_POLICY,
    repo: 'owner/name',
    remote: 'origin',
    defaultBranch: 'main',
    log: () => {},
    createLog: async () => nullLog(),
    verifier: async () => passingVerification(),
    // The suite never installs dependencies into its temporary repositories.
    installer: async () => ({ code: 0, stdout: '', stderr: '', timedOut: false, display: '' }),
    // Waiting is instantaneous, so a watch-mode test finishes in milliseconds.
    sleep: async () => {},
    ...rest,
    reviewers,
  }
}
