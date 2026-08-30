import { join, resolve } from 'node:path'
import {
  classifyRisk,
  DEFAULT_SELECTION_POLICY,
  type IssueSummary,
  type LoopPolicy,
  parseUnifiedDiff,
  type ReviewResult,
  type RiskAssessment,
  type SelectionPolicy,
  selectNextIssue,
} from '@newsdeck/loop'
import type { CodingAgent, ReviewAgent } from './agent.ts'
import { branchName, worktreeName } from './branch.ts'
import { INSTALL_STEP, type RunnerConfig } from './config.ts'
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
import type { GhClient, GhIssue } from './github.ts'
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
import { formatVerification, type VerificationOutcome, verify } from './verify.ts'

/**
 * The local execution plane.
 *
 * It picks up an issue, produces a branch, and hands the result to GitHub. It
 * deliberately stops there. Risk classification, the review gate and the merge
 * decision all live in the control plane, where the enforcement is GitHub's own
 * required checks — moving any of it down here would mean a laptop could
 * authorise its own merge.
 *
 * Two entry points: `runOnce` takes one issue through the coding phase, and
 * `advance` moves work that is already on GitHub forward. `watch` alternates
 * between them.
 */

export type StopReason =
  | 'nothing-ready'
  | 'max-issues-reached'
  | 'blocked'
  | 'in-flight'
  | 'awaiting-human'

export interface RunnerDeps {
  config: RunnerConfig
  policy: LoopPolicy
  /** Absolute path of the main checkout. */
  repository: string
  repo: string
  remote: string
  defaultBranch: string
  gh: GhClient
  coding: CodingAgent
  review: ReviewAgent
  selectionPolicy?: SelectionPolicy
  log: (line: string) => void
  now?: () => Date
  /** Overridden in tests so the suite never runs a real build. */
  verifier?: typeof verify
  /** Overridden in tests so the suite writes no log files. */
  createLog?: (root: string, issue: number) => Promise<ExecutionLog>
  /** Overridden in tests so the suite never installs dependencies. */
  installer?: typeof run
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

/**
 * Take one issue through the local coding phase.
 *
 * One, deliberately. Continuing to the next issue is `watch`'s job, and it only
 * does so once the previous pull request has actually landed. A runner that
 * fans out across the backlog while nobody is watching produces a pile of pull
 * requests nobody asked for.
 */
export async function runOnce(deps: RunnerDeps): Promise<OnceResult> {
  const path = journalPath(deps.repository)
  const journal = await readJournal(path)

  // Crash recovery, and the CI fix loop. An issue this machine already claimed
  // is resumed rather than a second one being claimed alongside it — and it is
  // only resumed when there is something to do, so a green pull request waiting
  // on a reviewer does not get pointlessly reworked.
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
  const selection = selectNextIssue(issues, deps.selectionPolicy ?? DEFAULT_SELECTION_POLICY)

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
      detail: `#${record.pullRequest} is ${state.toLowerCase()}. Run \`loop:watch\` once to clean up, then the next issue is available.`,
    }
  }

  const { verdict, failing } = summariseChecks(pullRequest)
  if (verdict !== 'failing') {
    return {
      actionable: false,
      detail: `#${record.issue} is with GitHub: pull request #${record.pullRequest}, checks ${verdict}. Nothing for the runner to do until that changes.`,
    }
  }

  if (record.fixRounds + 1 >= deps.config.LOCAL_AGENT_MAX_FIX_ROUNDS) {
    return {
      actionable: false,
      detail: `Checks on #${record.pullRequest} are failing (${failing.join(', ')}) and the ${deps.config.LOCAL_AGENT_MAX_FIX_ROUNDS}-round budget is spent. This needs a human.`,
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
    ].join('\n'),
  }
}

/**
 * Implement one issue, end to end, up to the pull request.
 *
 * The issue is claimed on GitHub before any work starts and moved to
 * `agent:blocked` on any failure. A run that dies mid-way must leave the
 * backlog in a state a human can read, not an issue that looks available but
 * has a half-finished branch behind it.
 */
export interface WorkOptions {
  /** First round index. Non-zero when resuming, so spent rounds stay spent. */
  startRound?: number
  /** Extra context for the first round, e.g. the failing CI checks. */
  feedback?: string
}

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
        body: detail,
      }),
    )
    return {
      issue: issue.number,
      branch,
      status: 'blocked',
      pullRequest: null,
      risk: null,
      detail,
    }
  }

  await save()

  try {
    await fetchBase(deps.repository, deps.remote, deps.defaultBranch)
    await ensureWorktree({ repository: deps.repository, path: worktree, branch, base })
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
  const maxRounds = deps.config.LOCAL_AGENT_MAX_FIX_ROUNDS

  let verification: VerificationOutcome | null = null
  let review: ReviewResult | undefined
  let risk: RiskAssessment | null = null
  let files: string[] = []
  let settled = false

  // One bounded loop covers both feedback sources. A verification failure and a
  // review that asks for changes are the same thing from here: evidence the
  // change is not finished, handed back to a fresh agent invocation, at most
  // `maxRounds` times. There is no path that repeats without consuming a round.
  const startRound = options.startRound ?? 0
  if (startRound >= maxRounds) {
    return fail(
      `The ${maxRounds}-round budget for this issue is already spent. Resuming would loop without end; this needs a human.`,
    )
  }

  for (let round = startRound; round < maxRounds; round += 1) {
    deps.log(`#${issue.number}: agent round ${round + 1} of ${maxRounds}`)

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

    deps.log(`#${issue.number}: verifying`)
    verification = await runVerify({ cwd: worktree })

    await logs.artifact(`verification-${round}.json`, verification)
    record = appendAttempt(record, {
      at: now().toISOString(),
      phase: 'verify',
      outcome: verification.ok ? 'ok' : 'failed',
      detail: formatVerification(verification).slice(0, 2000),
    })
    await save()

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

    // Commit before review so the reviewer reads the same tree GitHub will.
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

    // Classified locally only so the runner knows whether to stop for a human.
    // The value that gates the merge is recomputed in the workflow from the
    // same policy file; this one carries no authority.
    risk = classifyRisk({
      diff: parseUnifiedDiff(rawDiff),
      labels: issue.labels,
      policy: deps.policy,
    })
    await logs.artifact('risk.json', risk)

    deps.log(`#${issue.number}: local review (risk ${risk.risk})`)
    const reviewed = await deps.review.review({
      worktree,
      issue: issue.number,
      title: issue.title,
      body: issue.body ?? '',
      base: base,
      branch,
      diff: rawDiff,
      changedFiles: files,
    })

    await logs.artifact(`review-result-${round}.json`, reviewed)
    record = appendAttempt(record, {
      at: now().toISOString(),
      phase: 'review',
      outcome: reviewed.ok ? 'ok' : 'failed',
      detail: reviewed.ok ? reviewed.review.summary.slice(0, 2000) : reviewed.reason,
    })
    await save()

    // A review the runner cannot validate is never an approval. Malformed
    // output and a failed invocation are the same outcome: stop and say so.
    if (!reviewed.ok) {
      return fail(
        `The review agent did not return a usable result: ${reviewed.reason}\n\n${reviewed.detail}`,
      )
    }
    if (reviewed.review.status === 'blocked') {
      return fail(`The review agent blocked this change: ${reviewed.review.summary}`)
    }

    if (reviewed.review.status === 'request_changes') {
      if (round === maxRounds - 1) {
        return fail(
          `The review still asks for changes after ${maxRounds} round(s).\n\n${renderReview(reviewed.review)}`,
        )
      }
      deps.log(`#${issue.number}: review asked for changes; starting a fix round`)
      review = reviewed.review
      continue
    }

    review = reviewed.review
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

  // Serial by default: `watch` will not take another issue while this one is in
  // flight, and a high-risk change additionally waits for a person on GitHub.
  const gate =
    risk.risk === 'high'
      ? ' It is high risk, so it waits for a human: the loop will not merge it without an approval.'
      : ''

  deps.log(
    `#${issue.number}: pull request #${pullRequest} is open; the GitHub gate takes it from here.${gate}`,
  )

  return {
    issue: issue.number,
    branch,
    status,
    pullRequest,
    risk,
    detail: `Pull request #${pullRequest} (${status}), risk ${risk.risk}.${gate}`,
  }
}

export type AdvanceAction =
  | 'waiting-for-ci'
  | 'ci-failed-fixing'
  | 'awaiting-human'
  | 'merged'
  | 'closed'
  | 'retries-exhausted'
  | 'nothing-to-do'

export interface AdvanceOutcome {
  issue: number
  pullRequest: number | null
  action: AdvanceAction
  detail: string
}

/**
 * Move work that is already on GitHub forward by one step.
 *
 * The runner observes; it never decides. Whether a pull request may merge is
 * read off GitHub's own state — check runs, review decision, merge state — and
 * the only thing the runner does about a red one is start a bounded fix round.
 */
export async function advance(deps: RunnerDeps): Promise<AdvanceOutcome[]> {
  const path = journalPath(deps.repository)
  const journal = await readJournal(path)
  const outcomes: AdvanceOutcome[] = []

  for (const record of inFlight(journal)) {
    if (record.pullRequest === null) {
      outcomes.push({
        issue: record.issue,
        pullRequest: null,
        action: 'nothing-to-do',
        detail: 'No pull request yet; `loop:once` will resume it.',
      })
      continue
    }

    const pullRequest = await deps.gh.pullRequest(record.pullRequest)
    const state = pullRequest.state.toUpperCase()

    if (state === 'MERGED') {
      await finish(deps, record, 'done')
      outcomes.push({
        issue: record.issue,
        pullRequest: record.pullRequest,
        action: 'merged',
        detail: `#${record.pullRequest} merged; worktree cleaned up.`,
      })
      continue
    }

    if (state === 'CLOSED') {
      await finish(deps, record, 'done')
      outcomes.push({
        issue: record.issue,
        pullRequest: record.pullRequest,
        action: 'closed',
        detail: `#${record.pullRequest} was closed without merging. Leaving #${record.issue} to a human.`,
      })
      continue
    }

    const { verdict, failing } = summariseChecks(pullRequest)

    if (verdict === 'pending' || verdict === 'none') {
      outcomes.push({
        issue: record.issue,
        pullRequest: record.pullRequest,
        action: 'waiting-for-ci',
        detail: `Checks on #${record.pullRequest} are ${verdict}.`,
      })
      continue
    }

    if (verdict === 'failing') {
      if (record.fixRounds + 1 >= deps.config.LOCAL_AGENT_MAX_FIX_ROUNDS) {
        await block(
          deps,
          record,
          `CI is still failing after ${record.fixRounds + 1} round(s): ${failing.join(', ')}.`,
        )
        outcomes.push({
          issue: record.issue,
          pullRequest: record.pullRequest,
          action: 'retries-exhausted',
          detail: 'Retry budget spent; the issue is marked `agent:blocked`.',
        })
        continue
      }

      outcomes.push({
        issue: record.issue,
        pullRequest: record.pullRequest,
        action: 'ci-failed-fixing',
        detail: `Checks failing (${failing.join(', ')}). \`loop:once\` will start a fix round.`,
      })
      continue
    }

    // Green. Everything after this point is GitHub's decision, not the
    // runner's: a high-risk change waits for a human, and the merge itself is
    // performed by the repository's own auto-merge configuration. The runner
    // has no code path that merges, so there is nothing here to get wrong.
    const gate =
      record.risk === 'high'
        ? 'High risk: this needs a human approval on GitHub. The runner will not start another issue while it is open.'
        : 'The GitHub merge gate decides from here.'

    outcomes.push({
      issue: record.issue,
      pullRequest: record.pullRequest,
      action: 'awaiting-human',
      detail: `#${record.pullRequest} is green. Review decision: ${pullRequest.reviewDecision ?? 'none yet'}; merge state: ${pullRequest.mergeStateStatus ?? 'unknown'}. ${gate}`,
    })
  }

  return outcomes.length === 0
    ? [{ issue: 0, pullRequest: null, action: 'nothing-to-do', detail: 'Nothing in flight.' }]
    : outcomes
}

async function finish(
  deps: RunnerDeps,
  record: RunRecord,
  status: RunRecord['status'],
): Promise<void> {
  // Only ever the runner's own worktree, and only once GitHub says the pull
  // request is done with. Anything else is a developer's checkout — so the path
  // is re-derived from configuration rather than trusted from the journal.
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
      body: detail,
    }),
  )
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
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
    '## Verification',
    '',
    formatVerification(verification),
    '',
    '## Local risk classification',
    '',
    `\`${risk.risk}\` — ${risk.reasons.map((reason) => reason.detail).join('; ')}`,
    '',
    'Advisory. The value that gates this pull request is recomputed by `loop-pr.yml` from the same policy file.',
    '',
    '## Local pre-review',
    '',
  ]

  lines.push(
    review === null
      ? 'The local review agent did not produce a usable result. The authoritative review runs on this pull request.'
      : renderReview(review),
  )

  lines.push(
    '',
    '---',
    '',
    "Produced locally. It carries no merge authority: risk classification, review and merge are decided by this repository's GitHub workflows and required checks.",
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
  verification: string[]
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
      'claude -p --output-format json --permission-mode dontAsk --add-dir <worktree> --tools ... --allowedTools ... (prompt on stdin)',
    verification: ['bun run lint', 'bun run typecheck', 'bun run test', 'bun run build'],
    inFlight: inFlight(journal),
  }
}

export { nullLog }
