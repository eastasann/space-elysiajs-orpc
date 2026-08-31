import { join, resolve } from 'node:path'
import {
  aggregateReviews,
  classifyRiskMonotonic,
  DEFAULT_SELECTION_POLICY,
  type IssueSummary,
  type LoopPolicy,
  parsePolicy,
  parseUnifiedDiff,
  type ReviewResult,
  type RiskAssessment,
  reviewersForRisk,
  type SelectionPolicy,
  selectNextIssue,
} from '@newsdeck/loop'
import type { CodingAgent, ReviewAgent } from './agent.ts'
import { Backoff, isAuthFailure, isTransient } from './backoff.ts'
import { branchName, worktreeName } from './branch.ts'
import type { Budget } from './budget.ts'
import { INSTALL_STEP, issueBudget, type RunnerConfig } from './config.ts'
import { run } from './exec.ts'
import {
  changedFiles,
  commitAll,
  ensureWorktree,
  fetchBase,
  gitIn,
  hasCommitsBeyond,
  pushBranch,
  removeWorktree,
} from './git.ts'
import type { GhIssue, GitHubAdapter } from './github.ts'
import { summariseChecks } from './github.ts'
import {
  appendAttempt,
  findRun,
  type Journal,
  type RunRecord,
  readJournal,
  upsertRun,
  writeJournal,
} from './journal.ts'
import { createExecutionLog, type ExecutionLog, nullLog } from './logs.ts'
import { renderRunnerComment } from './report.ts'
import { renderReview } from './review-command.ts'
import { emptySummary, type RunSummary, recordIssue } from './summary.ts'
import { formatVerification, type VerificationOutcome, verify } from './verify.ts'

/**
 * The local execution plane, running unattended.
 *
 * It selects an issue, implements it, verifies it to the depth its risk
 * demands, reviews it independently, opens a pull request, and asks GitHub to
 * merge it. Then it does the next one. Nothing in the happy path waits for a
 * person.
 *
 * Two properties keep that safe rather than reckless:
 *
 * - **The runner never merges.** It enables GitHub's own auto-merge and GitHub
 *   decides whether the required checks actually passed. There is no code path
 *   here that merges anything, so a bug in this file cannot produce a merge the
 *   repository ruleset would have refused.
 * - **A stuck issue is not a stuck loop.** Every failure category is bounded;
 *   exhausting one marks that issue `agent:blocked` and the loop moves to
 *   independent work. Only the global stop conditions end the session.
 */

export type StopReason =
  | 'nothing-ready'
  | 'max-issues-reached'
  | 'blocked'
  | 'in-flight'
  | 'budget-exceeded'
  | 'github-unavailable'
  | 'agent-unavailable'
  | 'interrupted'

export interface RunnerDeps {
  config: RunnerConfig
  policy: LoopPolicy
  /** Absolute path of the main checkout. */
  repository: string
  repo: string
  remote: string
  defaultBranch: string
  gh: GitHubAdapter
  coding: CodingAgent
  /**
   * Independent reviewers, most-preferred first.
   *
   * The high-risk tier asks for two. They are separate objects on purpose:
   * a reviewer that shared the coder's session would be confirming its own
   * conclusions, and one that shared the other reviewer's would make the second
   * pass worthless.
   */
  reviewers: readonly ReviewAgent[]
  selectionPolicy?: SelectionPolicy
  log: (line: string) => void
  now?: () => Date
  budget?: Budget
  /** Overridden in tests so the suite never runs a real build. */
  verifier?: typeof verify
  /** Overridden in tests so the suite writes no log files. */
  createLog?: (root: string, issue: number) => Promise<ExecutionLog>
  /** Overridden in tests so the suite never installs dependencies. */
  installer?: typeof run
  /** Overridden in tests to make waiting instantaneous. */
  sleep?: (ms: number) => Promise<void>
}

export interface IssueOutcome {
  issue: number
  branch: string
  status: 'opened' | 'updated' | 'blocked' | 'skipped'
  pullRequest: number | null
  risk: RiskAssessment | null
  detail: string
}

export interface OnceResult {
  outcomes: IssueOutcome[]
  stopReason: StopReason
  detail: string
}

export function journalPath(repository: string): string {
  return join(repository, '.loop', 'state.json')
}

function toSummary(issue: GhIssue): IssueSummary {
  return {
    number: issue.number,
    title: issue.title,
    state: issue.state.toLowerCase() === 'closed' ? 'closed' : 'open',
    labels: issue.labels.map((label) => label.name),
    body: issue.body ?? null,
  }
}

/** Runs this machine started that GitHub has not finished with yet. */
export function inFlight(journal: Journal): RunRecord[] {
  return journal.runs.filter(
    (run) => run.status === 'in-progress' || run.status === 'awaiting-review',
  )
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// ---------------------------------------------------------------------------
// Unattended session
// ---------------------------------------------------------------------------

export interface UnattendedResult {
  summary: RunSummary
  stopReason: StopReason
}

/**
 * Run until there is genuinely nothing left to do.
 *
 * The loop alternates between moving open pull requests forward and taking new
 * issues, one at a time. Serial by choice: parallel issues would multiply the
 * ways two agents can collide on the same file, and the throughput gain is not
 * worth debugging that unattended.
 */
export async function runUnattended(
  deps: RunnerDeps,
  options: { stopping?: () => boolean } = {},
): Promise<UnattendedResult> {
  const now = deps.now ?? (() => new Date())
  const sleep = deps.sleep ?? ((ms: number) => Bun.sleep(ms))
  const stopping = options.stopping ?? (() => false)
  const backoff = new Backoff(deps.config)

  let summary = emptySummary('unattended', now())
  const limit = issueBudget(deps.config)
  const blockedThisRun: number[] = []
  let taken = 0

  const finish = (stopReason: StopReason, detail: string): UnattendedResult => {
    summary = {
      ...summary,
      finishedAt: now().toISOString(),
      stopReason: detail,
      modelInvocations: deps.budget?.snapshot().invocations ?? 0,
      runtimeMs: deps.budget?.snapshot().runtimeMs ?? 0,
    }
    return { summary, stopReason }
  }

  deps.log(
    `Unattended: ${limit === 0 ? 'no issue ceiling' : `at most ${limit} issue(s)`}, polling every ${deps.config.LOOP_POLL_INTERVAL_SECONDS}s.`,
  )

  while (!stopping()) {
    // --- Move open work forward -------------------------------------------
    let advanced: AdvanceOutcome[]
    try {
      advanced = await advance(deps)
    } catch (error) {
      const message = messageOf(error)
      const wait = await tolerate(deps, backoff, message, sleep)
      if (wait === 'stop') {
        return finish(
          isAuthFailure(message) ? 'github-unavailable' : 'github-unavailable',
          `GitHub stayed unreachable across ${backoff.failures} attempts: ${message}`,
        )
      }
      continue
    }

    for (const outcome of advanced) {
      if (outcome.issue === 0) continue
      deps.log(`#${outcome.issue}: ${outcome.action} — ${outcome.detail}`)

      if (outcome.action === 'merged') {
        summary = recordIssue(summary, {
          issue: outcome.issue,
          title: outcome.title,
          pullRequest: outcome.pullRequest,
          risk: outcome.risk,
          outcome: 'merged',
          detail: outcome.detail,
        })
      }
      if (outcome.action === 'retries-exhausted' || outcome.action === 'closed') {
        blockedThisRun.push(outcome.issue)
        summary = recordIssue(summary, {
          issue: outcome.issue,
          title: outcome.title,
          pullRequest: outcome.pullRequest,
          risk: outcome.risk,
          outcome: 'blocked',
          detail: outcome.detail,
        })
      }
    }

    // --- Take new work ------------------------------------------------------
    const journal = await readJournal(journalPath(deps.repository))
    const outstanding = inFlight(journal)

    if (outstanding.length === 0) {
      if (limit !== 0 && taken >= limit) {
        return finish('max-issues-reached', `the ${limit}-issue ceiling for this run was reached`)
      }

      const exceeded = deps.budget?.check() ?? null
      if (exceeded !== null) {
        return finish('budget-exceeded', `operational budget reached — ${exceeded.detail}`)
      }

      let result: OnceResult
      try {
        result = await runOnce(deps, { skip: blockedThisRun })
      } catch (error) {
        const message = messageOf(error)
        const wait = await tolerate(deps, backoff, message, sleep)
        if (wait === 'stop') {
          return finish(
            'github-unavailable',
            `the loop kept failing across ${backoff.failures} attempts: ${message}`,
          )
        }
        continue
      }

      for (const outcome of result.outcomes) {
        deps.log(`#${outcome.issue}: ${outcome.status} — ${outcome.detail}`)
        taken += 1
        deps.budget?.recordIssue()

        summary = recordIssue(summary, {
          issue: outcome.issue,
          title: `#${outcome.issue}`,
          pullRequest: outcome.pullRequest,
          risk: outcome.risk?.risk ?? null,
          outcome: outcome.status === 'blocked' ? 'blocked' : 'open',
          detail: outcome.detail,
        })

        // Block-and-continue. One issue giving up is not the loop giving up.
        if (outcome.status === 'blocked') {
          blockedThisRun.push(outcome.issue)
          deps.log(`#${outcome.issue} is blocked; moving to independent work.`)
        }
      }

      if (result.stopReason === 'nothing-ready' && result.outcomes.length === 0) {
        // The one legitimate finish: no issue is ready and nothing is open.
        return finish('nothing-ready', result.detail)
      }
    }

    // Only a cycle that got all the way here counts as recovery. Resetting on
    // a partial success — `advance` working while `runOnce` keeps failing —
    // would make the consecutive-failure ceiling unreachable and spin forever.
    backoff.succeeded()

    if (stopping()) break
    await sleep(deps.config.LOOP_POLL_INTERVAL_SECONDS * 1000)
  }

  return finish('interrupted', 'the runner was asked to stop')
}

/**
 * Wait out a transient failure, or say the loop should stop.
 *
 * Authentication loss is treated as transient on purpose: a token that expired
 * may be renewed by the person whose machine this is, and the alternative —
 * exiting — loses the session's state for a problem that often fixes itself.
 * What it must never do is keep claiming issues while it cannot label them,
 * which is why this is only ever reached between issues.
 */
async function tolerate(
  deps: RunnerDeps,
  backoff: Backoff,
  message: string,
  sleep: (ms: number) => Promise<void>,
): Promise<'retry' | 'stop'> {
  const kind = isAuthFailure(message)
    ? 'authentication'
    : isTransient(message)
      ? 'transient'
      : 'unexpected'

  const next = backoff.failed()
  if (next === null) return 'stop'

  deps.log(
    `${kind} failure (${next.consecutive}/${deps.config.LOOP_MAX_CONSECUTIVE_FAILURES}): ${message}. Waiting ${Math.round(next.waitMs / 1000)}s.`,
  )
  if (kind === 'authentication') {
    deps.log('Not claiming new work until access returns. Nothing is lost; state lives on GitHub.')
  }

  await sleep(next.waitMs)
  return 'retry'
}

// ---------------------------------------------------------------------------
// One issue
// ---------------------------------------------------------------------------

export interface RunOnceOptions {
  /** Issues this session already gave up on. */
  skip?: readonly number[]
}

/**
 * Take one issue through the local coding phase.
 *
 * Resumes an in-flight issue when there is something to do for it, and
 * otherwise selects the next eligible one.
 */
export async function runOnce(deps: RunnerDeps, options: RunOnceOptions = {}): Promise<OnceResult> {
  const path = journalPath(deps.repository)
  const journal = await readJournal(path)

  const outstanding = inFlight(journal)
  if (outstanding.length > 0) {
    const record = outstanding[0] as RunRecord
    const resume = await resumable(deps, record)

    if (!resume.actionable) {
      return { outcomes: [], stopReason: 'in-flight', detail: resume.detail }
    }

    deps.log(`Resuming #${record.issue}: ${resume.detail}`)
    const issue = toSummary(await deps.gh.issue(record.issue))
    const resumed = await workIssue(deps, issue, {
      // Rounds already spent stay spent. Restarting the runner must not hand
      // the agent a fresh budget, or the retry limit means nothing.
      startRound: record.fixRounds + 1,
      feedback: resume.feedback,
    })

    return {
      outcomes: [resumed],
      stopReason: resumed.status === 'blocked' ? 'blocked' : 'max-issues-reached',
      detail: resumed.detail,
    }
  }

  const issues = (await deps.gh.issues([])).map(toSummary)
  const policy: SelectionPolicy = {
    ...(deps.selectionPolicy ?? DEFAULT_SELECTION_POLICY),
    skip: options.skip,
  }
  const selection = selectNextIssue(issues, policy)

  if (selection.selected === null) {
    return {
      outcomes: [],
      stopReason: 'nothing-ready',
      detail: selection.stopReason ?? 'No issue is ready.',
    }
  }

  const outcome = await workIssue(deps, selection.selected)

  return {
    outcomes: [outcome],
    stopReason: outcome.status === 'blocked' ? 'blocked' : 'max-issues-reached',
    detail: outcome.detail,
  }
}

interface Resumption {
  actionable: boolean
  detail: string
  feedback?: string
}

/** Whether an in-flight run has work left that this machine can do. */
async function resumable(deps: RunnerDeps, record: RunRecord): Promise<Resumption> {
  if (record.pullRequest === null) {
    return { actionable: true, detail: 'no pull request was opened yet' }
  }

  const pullRequest = await deps.gh.pullRequest(record.pullRequest)
  const state = pullRequest.state.toUpperCase()

  if (state === 'MERGED' || state === 'CLOSED') {
    return {
      actionable: false,
      detail: `#${record.pullRequest} is ${state.toLowerCase()}; the next cycle will clean it up.`,
    }
  }

  const mergeability = await deps.gh.mergeability(record.pullRequest)
  if (mergeability === 'conflicted') {
    if (record.conflictRounds >= deps.config.LOOP_CONFLICT_ROUNDS) {
      return {
        actionable: false,
        detail: `#${record.pullRequest} is conflicted and the ${deps.config.LOOP_CONFLICT_ROUNDS}-attempt budget is spent.`,
      }
    }
    return {
      actionable: true,
      detail: 'the pull request has a merge conflict',
      feedback: [
        '### This pull request conflicts with the base branch',
        '',
        'The base branch has moved on and the merge is no longer clean. Resolve the',
        'conflict in favour of both intents: keep the change this issue asks for and',
        'keep whatever landed on the base branch. Do not discard either side.',
      ].join('\n'),
    }
  }

  const { verdict, failing } = summariseChecks(pullRequest)
  if (verdict !== 'failing') {
    return {
      actionable: false,
      detail: `#${record.issue} is with GitHub: pull request #${record.pullRequest}, checks ${verdict}. Nothing for the runner to do until that changes.`,
    }
  }

  if (record.ciRounds + 1 >= deps.config.LOOP_CI_FIX_ROUNDS) {
    return {
      actionable: false,
      detail: `Checks on #${record.pullRequest} are failing (${failing.join(', ')}) and the ${deps.config.LOOP_CI_FIX_ROUNDS}-round budget is spent. This needs a human.`,
    }
  }

  return {
    actionable: true,
    detail: `checks are failing (${failing.join(', ')})`,
    feedback: [
      '### GitHub CI is failing',
      '',
      'These required checks are red on the pull request:',
      '',
      ...failing.map((name) => `- ${name}`),
      '',
      "Reproduce them locally with the repository's own commands and fix the cause.",
      'Do not weaken or skip a test to make a check pass — that is caught and it blocks the merge.',
    ].join('\n'),
  }
}

export interface WorkOptions {
  /** First round index. Non-zero when resuming, so spent rounds stay spent. */
  startRound?: number
  /** Extra context for the first round, e.g. the failing CI checks. */
  feedback?: string
}

/**
 * Implement one issue, end to end, up to the pull request.
 *
 * The issue is claimed on GitHub before any work starts and moved to
 * `agent:blocked` on any failure. A run that dies mid-way must leave the
 * backlog in a state a human can read, not an issue that looks available but
 * has a half-finished branch behind it.
 */
export async function workIssue(
  deps: RunnerDeps,
  issue: IssueSummary,
  options: WorkOptions = {},
): Promise<IssueOutcome> {
  const now = deps.now ?? (() => new Date())
  const path = journalPath(deps.repository)
  const branch = branchName(issue.number, issue.title)
  const worktree = resolve(
    deps.repository,
    deps.config.LOOP_WORKTREE_ROOT,
    worktreeName(issue.number),
  )
  const base = `${deps.remote}/${deps.defaultBranch}`
  const logs = await (deps.createLog ?? createExecutionLog)(deps.repository, issue.number)

  deps.log(`Claiming #${issue.number}: ${issue.title}`)
  await logs.line(`claim #${issue.number}`)
  await deps.gh.addLabels(issue.number, ['agent:in-progress'])
  await deps.gh.removeLabel(issue.number, 'agent:ready')

  let journal = await readJournal(path)
  let record: RunRecord = findRun(journal, issue.number) ?? {
    issue: issue.number,
    branch,
    worktree,
    startedAt: now().toISOString(),
    updatedAt: now().toISOString(),
    status: 'in-progress',
    fixRounds: 0,
    ciRounds: 0,
    conflictRounds: 0,
    pullRequest: null,
    risk: null,
    attempts: [],
  }
  record = { ...record, branch, worktree, status: 'in-progress' }

  const save = async () => {
    journal = upsertRun(journal, record)
    await writeJournal(path, journal)
  }

  const fail = async (detail: string): Promise<IssueOutcome> => {
    record = { ...record, status: 'blocked' }
    await save()
    await logs.line(`blocked: ${detail}`)
    await deps.gh.removeLabel(issue.number, 'agent:in-progress')
    await deps.gh.addLabels(issue.number, ['agent:blocked'])
    await deps.gh.comment(
      issue.number,
      renderRunnerComment({
        issue: issue.number,
        branch,
        agent: deps.coding.name,
        phase: 'stopped',
        body: `${detail}\n\nThe loop has moved on to independent work. This issue needs a person; nothing else is waiting on it.`,
      }),
    )
    return {
      issue: issue.number,
      branch,
      status: 'blocked',
      pullRequest: record.pullRequest,
      risk: null,
      detail,
    }
  }

  await save()

  // Always start from current remote state. A worktree based on a stale base is
  // how "it passed locally" becomes "it failed in CI".
  try {
    await fetchBase(deps.repository, deps.remote, deps.defaultBranch)
    await ensureWorktree({ repository: deps.repository, path: worktree, branch, base })
    await rebaseOntoBase(worktree, base)
  } catch (error) {
    return fail(`Could not prepare the worktree: ${messageOf(error)}`)
  }

  // A fresh worktree has no `node_modules`. Without this every verification
  // step fails for a reason that has nothing to do with the change.
  deps.log(`#${issue.number}: installing dependencies`)
  const installed = await (deps.installer ?? run)(INSTALL_STEP.command, [...INSTALL_STEP.args], {
    cwd: worktree,
    timeoutMs: 15 * 60 * 1000,
  })
  if (installed.code !== 0) {
    return fail(
      `\`bun install --frozen-lockfile\` failed in the worktree:\n\n${installed.stderr.trim().slice(-2000)}`,
    )
  }

  const runVerify = deps.verifier ?? verify
  const maxRounds = deps.config.LOOP_CODING_FIX_ROUNDS
  const startRound = options.startRound ?? 0

  if (startRound >= maxRounds) {
    return fail(
      `The ${maxRounds}-round budget for this issue is already spent. Resuming would loop without end; this needs a human.`,
    )
  }

  let verification: VerificationOutcome | null = null
  let review: ReviewResult | undefined
  let risk: RiskAssessment | null = null
  let files: string[] = []
  let settled = false

  // One bounded loop covers every feedback source. A verification failure, a
  // review that asks for changes, and a red CI check are all the same thing
  // from here: evidence the change is not finished, handed to a fresh agent
  // invocation, at most `maxRounds` times. No path repeats without spending a
  // round, which is what makes the limit mean something.
  for (let round = startRound; round < maxRounds; round += 1) {
    deps.log(`#${issue.number}: agent round ${round + 1} of ${maxRounds}`)
    deps.budget?.recordInvocation()

    const coded = await deps.coding.implement({
      issue: issue.number,
      title: issue.title,
      body: issue.body ?? '',
      worktree,
      branch,
      round,
      review,
      verification: verification ?? undefined,
      feedback: round === startRound ? options.feedback : undefined,
    })

    await logs.artifact(`coding-result-${round}.json`, coded)
    record = appendAttempt(
      { ...record, fixRounds: round },
      {
        at: now().toISOString(),
        phase: round === 0 ? 'implement' : 'fix',
        outcome: coded.ok ? 'ok' : 'failed',
        detail: (coded.ok ? coded.summary : `${coded.reason}: ${coded.detail}`).slice(0, 2000),
      },
    )
    await save()

    if (!coded.ok) {
      return fail(`The coding agent stopped: ${coded.reason}\n\n${coded.detail}`)
    }

    // Commit first so risk is classified from the same tree that will be
    // verified, reviewed and pushed.
    try {
      const committed = await commitAll({
        cwd: worktree,
        message: `${issue.title}\n\nCloses #${issue.number}`,
      })
      if (!committed && !(await hasCommitsBeyond(worktree, base))) {
        return fail('The agent produced no change. There is nothing to open a pull request for.')
      }
    } catch (error) {
      return fail(`Could not commit: ${messageOf(error)}`)
    }

    files = await changedFiles(worktree, base)
    const rawDiff = (await gitIn(worktree)(['diff', `${base}...HEAD`])).stdout

    // Classified under the base branch's policy, and under the proposed one
    // when the change edits it — the stricter answer wins, so a pull request
    // cannot lower its own risk.
    risk = classifyRiskMonotonic({
      diff: parseUnifiedDiff(rawDiff),
      labels: issue.labels,
      basePolicy: deps.policy,
      headPolicy: await proposedPolicy(worktree, deps.policy),
    })
    record = { ...record, risk: risk.risk }
    await logs.artifact('risk.json', risk)

    deps.log(`#${issue.number}: verifying at \`${risk.risk}\` risk`)
    verification = await runVerify({
      cwd: worktree,
      risk: risk.risk,
      policy: deps.policy,
      changedFiles: files,
    })

    await logs.artifact(`verification-${round}.json`, verification)
    record = appendAttempt(record, {
      at: now().toISOString(),
      phase: 'verify',
      outcome: verification.ok ? 'ok' : 'failed',
      detail: formatVerification(verification).slice(0, 2000),
    })
    await save()

    // A step that could not run is not a step that passed, and no amount of
    // agent effort will install Docker. Block, and let the loop move on.
    if (verification.unavailable.length > 0) {
      return fail(
        `The \`${risk.risk}\` tier requires verification this machine cannot perform: ${verification.unavailable.join(', ')}.\n\n${formatVerification(verification)}`,
      )
    }

    if (!verification.ok) {
      if (round === maxRounds - 1) {
        return fail(
          `Local verification is still failing after ${maxRounds} round(s).\n\n${formatVerification(verification)}`,
        )
      }
      deps.log(`#${issue.number}: verification failed; asking for a fix`)
      review = undefined
      continue
    }

    // --- Independent review ------------------------------------------------
    const required = reviewersForRisk(deps.policy, risk.risk)
    deps.log(`#${issue.number}: ${required} independent review pass(es) for \`${risk.risk}\` risk`)

    const reviews = await gatherReviews(deps, required, {
      worktree,
      issue: issue.number,
      title: issue.title,
      body: issue.body ?? '',
      base,
      branch,
      diff: rawDiff,
      changedFiles: files,
    })
    await logs.artifact(`review-results-${round}.json`, reviews)

    record = appendAttempt(record, {
      at: now().toISOString(),
      phase: 'review',
      outcome: reviews.usable.length === required ? 'ok' : 'failed',
      detail: `${reviews.usable.length}/${required} usable review(s)`,
    })
    await save()

    if (reviews.usable.length < required) {
      return fail(
        `Only ${reviews.usable.length} of ${required} required independent review(s) produced a usable result. A missing review is never an approval.\n\n${reviews.failures.join('\n')}`,
      )
    }

    const verdict = combine(reviews.usable, deps.policy)

    if (verdict.status === 'blocked') {
      return fail(`Independent review blocked this change: ${verdict.summary}`)
    }

    if (verdict.status === 'request_changes') {
      if (round === maxRounds - 1) {
        return fail(
          `Review still asks for changes after ${maxRounds} round(s).\n\n${renderReview(verdict)}`,
        )
      }
      deps.log(`#${issue.number}: review asked for changes; starting a fix round`)
      review = verdict
      continue
    }

    review = verdict
    settled = true
    break
  }

  if (!settled || verification === null || risk === null) {
    return fail('The change never reached a reviewable, verified state.')
  }

  try {
    const pushed = await pushBranch({ cwd: worktree, remote: deps.remote, branch })
    if (pushed.code !== 0) {
      return fail(`Could not push \`${branch}\`: ${pushed.stderr.trim() || pushed.stdout.trim()}`)
    }
  } catch (error) {
    return fail(`Could not push: ${messageOf(error)}`)
  }

  // Reuse the pull request this issue already has. Opening a second one for the
  // same issue is how an unattended loop turns one problem into a pile.
  const existing = await deps.gh.pullRequestForBranch(branch)
  let pullRequest: number
  let status: IssueOutcome['status']

  if (existing !== null && existing.state.toUpperCase() === 'OPEN') {
    pullRequest = existing.number
    status = 'updated'
  } else {
    pullRequest = await deps.gh.createPullRequest({
      base: deps.defaultBranch,
      head: branch,
      title: issue.title,
      body: pullRequestBody(issue, files, verification, review ?? null, risk),
    })
    status = 'opened'
  }

  record = {
    ...appendAttempt(record, {
      at: now().toISOString(),
      phase: 'publish',
      outcome: 'ok',
      detail: `Pull request #${pullRequest}`,
    }),
    status: 'awaiting-review',
    pullRequest,
    risk: risk.risk,
  }
  await save()
  await logs.line(`pull request #${pullRequest} (${status})`)

  await deps.gh.removeLabel(issue.number, 'agent:in-progress')
  await deps.gh.addLabels(issue.number, ['agent:review'])

  // Hand it to GitHub. Auto-merge fires when GitHub's own required checks pass,
  // which is the only thing that actually merges anything.
  try {
    await deps.gh.enableAutoMerge(pullRequest)
    deps.log(`#${issue.number}: auto-merge requested on #${pullRequest}`)
  } catch (error) {
    // Not fatal: the pull request is open and correct, and a person or a later
    // cycle can enable it. Silence here would be the bug.
    deps.log(
      `#${issue.number}: could not enable auto-merge on #${pullRequest} (${messageOf(error)}). The pull request stands; merge is unaffected by the runner either way.`,
    )
  }

  return {
    issue: issue.number,
    branch,
    status,
    pullRequest,
    risk,
    detail: `Pull request #${pullRequest} (${status}), \`${risk.risk}\` risk, auto-merge requested.`,
  }
}

/** Bring the worktree onto current base, so verification reflects what will merge. */
async function rebaseOntoBase(worktree: string, base: string): Promise<void> {
  const git = gitIn(worktree)
  const behind = await git(['rev-list', '--count', `HEAD..${base}`])
  if (behind.code !== 0 || Number(behind.stdout.trim()) === 0) return

  // Merge rather than rebase: the branch may already be pushed, and rewriting
  // published history would invalidate anyone's checkout of it.
  const merged = await git(['merge', '--no-edit', base])
  if (merged.code !== 0) {
    // Leave the conflict in place for the coding agent to resolve.
    await git(['merge', '--abort'])
  }
}

/** The policy as this worktree proposes it, when the change edits the policy. */
async function proposedPolicy(
  worktree: string,
  fallback: LoopPolicy,
): Promise<LoopPolicy | undefined> {
  try {
    const text = await Bun.file(join(worktree, '.github', 'loop-policy.json')).text()
    const parsed = parsePolicy(JSON.parse(text))
    return JSON.stringify(parsed) === JSON.stringify(fallback) ? undefined : parsed
  } catch {
    // Unreadable or absent: the base policy governs, which is the safe default.
    return undefined
  }
}

interface GatheredReviews {
  usable: ReviewResult[]
  failures: string[]
}

/**
 * Run the independent review passes a tier requires.
 *
 * Each pass is a different `ReviewAgent` object and therefore a different Claude
 * Code invocation with no shared session. A reviewer whose output cannot be
 * validated is retried, and if it still cannot be validated it is *absent* from
 * the result rather than counted — the aggregate then sees fewer reviews than
 * required and blocks, which is the fail-closed behaviour that makes dual review
 * worth running at all.
 */
async function gatherReviews(
  deps: RunnerDeps,
  required: number,
  task: Parameters<ReviewAgent['review']>[0],
): Promise<GatheredReviews> {
  const usable: ReviewResult[] = []
  const failures: string[] = []

  for (let index = 0; index < required; index += 1) {
    const reviewer = deps.reviewers[index] ?? deps.reviewers[deps.reviewers.length - 1]
    if (reviewer === undefined) {
      failures.push(`No reviewer is configured for pass ${index + 1}.`)
      continue
    }

    let attempt = 0
    for (; attempt < deps.config.LOOP_REVIEWER_RETRY_ROUNDS; attempt += 1) {
      deps.budget?.recordInvocation()
      const outcome = await reviewer.review(task)

      if (outcome.ok) {
        usable.push(outcome.review)
        break
      }
      failures.push(`Reviewer ${index + 1}, attempt ${attempt + 1}: ${outcome.reason}`)
    }
  }

  return { usable, failures }
}

/** Combine independent reviews into one verdict, fail-closed. */
function combine(reviews: readonly ReviewResult[], policy: LoopPolicy): ReviewResult {
  // Reuses the control plane's own aggregator, so the runner and the workflow
  // cannot disagree about what two reviews add up to.
  const outcome = aggregateReviews({
    reviews,
    required: reviews.length,
    blockingSeverity: policy.review.blockingSeverity,
  })
  return { status: outcome.status, findings: outcome.findings, summary: outcome.summary }
}

// ---------------------------------------------------------------------------
// Driving open pull requests
// ---------------------------------------------------------------------------

export type AdvanceAction =
  | 'waiting-for-ci'
  | 'ci-failed-fixing'
  | 'conflict'
  | 'updated-branch'
  | 'awaiting-merge'
  | 'merged'
  | 'closed'
  | 'retries-exhausted'
  | 'nothing-to-do'

export interface AdvanceOutcome {
  issue: number
  title: string
  pullRequest: number | null
  risk: 'low' | 'medium' | 'high' | null
  action: AdvanceAction
  detail: string
}

/**
 * Move work that is already on GitHub forward by one step.
 *
 * The runner observes; GitHub decides. Whether a pull request may merge is read
 * off GitHub's own state, and the only things the runner does about it are
 * bounded: update a stale branch, start a fix round, or give up on this issue
 * and move to another.
 */
export async function advance(deps: RunnerDeps): Promise<AdvanceOutcome[]> {
  const path = journalPath(deps.repository)
  const journal = await readJournal(path)
  const outcomes: AdvanceOutcome[] = []

  for (const record of inFlight(journal)) {
    const base = {
      issue: record.issue,
      title: `#${record.issue}`,
      pullRequest: record.pullRequest,
      risk: record.risk,
    }

    if (record.pullRequest === null) {
      outcomes.push({
        ...base,
        action: 'nothing-to-do',
        detail: 'No pull request yet; the next cycle will resume it.',
      })
      continue
    }

    const pullRequest = await deps.gh.pullRequest(record.pullRequest)
    const state = pullRequest.state.toUpperCase()

    if (state === 'MERGED') {
      await finish(deps, record, 'done')
      outcomes.push({
        ...base,
        action: 'merged',
        detail: `#${record.pullRequest} merged; worktree cleaned up.`,
      })
      continue
    }

    if (state === 'CLOSED') {
      await finish(deps, record, 'done')
      outcomes.push({
        ...base,
        action: 'closed',
        detail: `#${record.pullRequest} was closed without merging. Leaving #${record.issue} to a person.`,
      })
      continue
    }

    const mergeability = await deps.gh.mergeability(record.pullRequest)

    if (mergeability === 'behind') {
      // Merging code that was verified against an older base is exactly how a
      // green pull request breaks the branch it lands on.
      try {
        await deps.gh.updateBranch(record.pullRequest)
        outcomes.push({
          ...base,
          action: 'updated-branch',
          detail: `#${record.pullRequest} was behind the base branch; updated, and checks will re-run.`,
        })
        continue
      } catch (error) {
        deps.log(`Could not update #${record.pullRequest}: ${messageOf(error)}`)
      }
    }

    if (mergeability === 'conflicted') {
      outcomes.push({
        ...base,
        action: 'conflict',
        detail: `#${record.pullRequest} has a merge conflict; the next cycle will attempt a bounded resolution.`,
      })
      continue
    }

    const { verdict, failing } = summariseChecks(pullRequest)

    if (verdict === 'pending' || verdict === 'none') {
      outcomes.push({
        ...base,
        action: 'waiting-for-ci',
        detail: `Checks on #${record.pullRequest} are ${verdict}.`,
      })
      continue
    }

    if (verdict === 'failing') {
      if (record.ciRounds + 1 >= deps.config.LOOP_CI_FIX_ROUNDS) {
        await block(
          deps,
          record,
          `CI is still failing after ${record.ciRounds + 1} round(s): ${failing.join(', ')}.`,
        )
        outcomes.push({
          ...base,
          action: 'retries-exhausted',
          detail: 'Retry budget spent; the issue is marked `agent:blocked` and the loop moves on.',
        })
        continue
      }

      await writeJournal(
        path,
        upsertRun(await readJournal(path), { ...record, ciRounds: record.ciRounds + 1 }),
      )
      outcomes.push({
        ...base,
        action: 'ci-failed-fixing',
        detail: `Checks failing (${failing.join(', ')}); the next cycle will start a fix round.`,
      })
      continue
    }

    // Green. GitHub's auto-merge decides from here; the runner has no merge
    // call at all, so there is nothing here to get wrong.
    outcomes.push({
      ...base,
      action: 'awaiting-merge',
      detail: `#${record.pullRequest} is green. Merge state: ${pullRequest.mergeStateStatus ?? 'unknown'}. GitHub's auto-merge takes it from here.`,
    })
  }

  return outcomes.length === 0
    ? [
        {
          issue: 0,
          title: '',
          pullRequest: null,
          risk: null,
          action: 'nothing-to-do',
          detail: 'Nothing in flight.',
        },
      ]
    : outcomes
}

async function finish(
  deps: RunnerDeps,
  record: RunRecord,
  status: RunRecord['status'],
): Promise<void> {
  // Only ever the runner's own worktree, and only once GitHub says the pull
  // request is done with. The path is re-derived from configuration rather than
  // trusted from the journal, so a corrupted journal cannot point the runner at
  // a directory it did not create.
  const expected = resolve(
    deps.repository,
    deps.config.LOOP_WORKTREE_ROOT,
    worktreeName(record.issue),
  )
  if (record.worktree === expected) {
    await removeWorktree(deps.repository, record.worktree).catch(() => {})
  }

  const path = journalPath(deps.repository)
  const journal = await readJournal(path)
  await writeJournal(path, upsertRun(journal, { ...record, status }))
}

async function block(deps: RunnerDeps, record: RunRecord, detail: string): Promise<void> {
  const path = journalPath(deps.repository)
  const journal = await readJournal(path)
  await writeJournal(path, upsertRun(journal, { ...record, status: 'blocked' }))

  await deps.gh.removeLabel(record.issue, 'agent:review')
  await deps.gh.addLabels(record.issue, ['agent:blocked'])
  await deps.gh.comment(
    record.issue,
    renderRunnerComment({
      issue: record.issue,
      branch: record.branch,
      agent: deps.coding.name,
      phase: 'stopped',
      body: `${detail}\n\nThe loop has moved on to independent work. This issue needs a person; nothing else is waiting on it.`,
    }),
  )
}

export function pullRequestBody(
  issue: IssueSummary,
  files: readonly string[],
  verification: VerificationOutcome,
  review: ReviewResult | null,
  risk: RiskAssessment,
): string {
  const lines = [
    `Closes #${issue.number}`,
    '',
    '## What changed',
    '',
    `Implemented by the local Claude Code runner. ${files.length} file(s) changed.`,
    '',
    `## Risk: \`${risk.risk}\``,
    '',
    ...risk.reasons.map((reason) => `- ${reason.detail}`),
    '',
    `Risk decides how much verification this change had to pass, not whether a person must approve it. Classified under the base branch's policy${risk.reasons.some((reason) => reason.source === 'base-policy') ? ', which governs because this pull request proposes a different one' : ''}.`,
    '',
    '## Verification',
    '',
    formatVerification(verification),
    '',
    '## Independent review',
    '',
  ]

  lines.push(
    review === null
      ? 'No usable review result. This pull request cannot merge without one.'
      : renderReview(review),
  )

  lines.push(
    '',
    '---',
    '',
    "Produced by an unattended loop. The runner has no merge authority: it enables GitHub's own auto-merge, and GitHub's required checks decide whether this actually lands.",
  )

  return lines.join('\n')
}

/** What `--dry-run` prints. Reads GitHub; changes nothing. */
export interface DryRunPlan {
  selected: IssueSummary | null
  stopReason: string | null
  branch: string | null
  worktree: string | null
  command: string
  order: Array<{ issue: number; title: string; eligible: boolean; reason: string }>
  inFlight: RunRecord[]
}

export async function planDryRun(deps: RunnerDeps): Promise<DryRunPlan> {
  const journal = await readJournal(journalPath(deps.repository))
  const issues = (await deps.gh.issues([])).map(toSummary)
  const selection = selectNextIssue(issues, deps.selectionPolicy ?? DEFAULT_SELECTION_POLICY)

  const selected = selection.selected
  return {
    selected,
    stopReason: selection.stopReason,
    branch: selected === null ? null : branchName(selected.number, selected.title),
    worktree:
      selected === null
        ? null
        : resolve(deps.repository, deps.config.LOOP_WORKTREE_ROOT, worktreeName(selected.number)),
    command:
      'claude -p --output-format json --permission-mode dontAsk --add-dir <worktree> --tools ... (prompt on stdin)',
    order: selection.candidates.map((candidate) => ({
      issue: candidate.issue.number,
      title: candidate.issue.title,
      eligible: candidate.eligible,
      reason: candidate.eligible ? 'eligible' : candidate.reasons.join('; '),
    })),
    inFlight: inFlight(journal),
  }
}

export { nullLog }
