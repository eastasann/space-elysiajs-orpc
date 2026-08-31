#!/usr/bin/env bun
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parsePolicy, reviewersForRisk } from '@newsdeck/loop'
import { Budget } from '../src/budget.ts'
import { ClaudeCodeCodingAgent, ClaudeCodeReviewAgent } from '../src/claude-agent.ts'
import { issueBudget, loadConfig, type RunnerConfig } from '../src/config.ts'
import { run } from '../src/exec.ts'
import { currentBranch, repositoryRoot } from '../src/git.ts'
import { createGhClient, summariseChecks } from '../src/github.ts'
import { readJournal } from '../src/journal.ts'
import { acquireLock } from '../src/lock.ts'
import {
  inFlight,
  journalPath,
  planDryRun,
  type RunnerDeps,
  runOnce,
  runUnattended,
} from '../src/orchestrator.ts'
import { formatPreflight, preflight } from '../src/preflight.ts'
import { redact } from '../src/redact.ts'
import { renderReview, reviewPullRequest } from '../src/review-command.ts'
import { formatSummary, type RunSummary } from '../src/summary.ts'

/**
 * `bun run loop:<command>`.
 *
 * Four commands. Only `once` and `watch` change anything, and neither merges —
 * that is GitHub's job, and the runner has no path to it.
 *
 * `watch --unattended` is the mode this repository is meant to run in: leave it
 * going and it works the backlog until there is nothing left it can do.
 */

const COMMANDS = ['status', 'once', 'watch', 'review'] as const
type Command = (typeof COMMANDS)[number]

function usage(): string {
  return [
    'Usage: bun tooling/local-runner/bin/loop.ts <command> [options]',
    '',
    'Commands:',
    '  status              Readiness, mode, current phase, backlog, blockers',
    '  once                Take one issue through to a pull request, then stop',
    '  watch               Drive open work and take new issues, on an interval',
    '  review <number>     Post an advisory review on a pull request',
    '',
    'Options:',
    '  --unattended        Keep going until there is genuinely nothing left to do',
    '  --max-issues N      Ceiling for this run (0 = unlimited)',
    '  --dry-run           Report the plan; change nothing, invoke no agent',
    '  --repo owner/name   Override the repository (defaults to the git remote)',
    '  --help',
    '',
    'Configuration comes from the environment; see docs/local-agent-runner.md.',
  ].join('\n')
}

interface Args {
  command: Command
  dryRun: boolean
  unattended: boolean
  maxIssues: number | null
  repo: string | null
  positional: string[]
}

export function parseArgs(argv: readonly string[]): Args | { help: true } | { error: string } {
  const positional: string[] = []
  let dryRun = false
  let unattended = false
  let maxIssues: number | null = null
  let repo: string | null = null

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] as string
    if (arg === '--help' || arg === '-h') return { help: true }
    if (arg === '--dry-run') dryRun = true
    else if (arg === '--unattended') unattended = true
    else if (arg === '--max-issues') {
      const value = argv[index + 1]
      if (value === undefined || !/^\d{1,4}$/.test(value)) {
        return { error: '--max-issues needs a non-negative number (0 means unlimited)' }
      }
      maxIssues = Number(value)
      index += 1
    } else if (arg === '--repo') {
      const value = argv[index + 1]
      if (value === undefined) return { error: '--repo needs a value' }
      // Anything that is not `owner/name` is rejected here rather than handed
      // to `gh`: it ends up in the argv of a subprocess.
      if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(value)) {
        return { error: `--repo must be owner/name, got: ${value}` }
      }
      repo = value
      index += 1
    } else if (arg.startsWith('-')) return { error: `Unknown option: ${arg}` }
    else positional.push(arg)
  }

  const command = positional.shift()
  if (command === undefined) return { help: true }
  if (!COMMANDS.includes(command as Command)) return { error: `Unknown command: ${command}` }

  return { command: command as Command, dryRun, unattended, maxIssues, repo, positional }
}

const log = (line: string) => {
  process.stdout.write(`${redact(line)}\n`)
}

/** Command-line flags override the environment, as flags should. */
export function applyFlags(config: RunnerConfig, args: Args): RunnerConfig {
  return {
    ...config,
    LOOP_UNATTENDED: args.unattended || config.LOOP_UNATTENDED,
    LOOP_MAX_ISSUES: args.maxIssues ?? config.LOOP_MAX_ISSUES,
  }
}

/** `owner/name` from the git remote, so the runner acts on the checkout it is in. */
async function detectRepo(repository: string): Promise<string> {
  const result = await run('git', ['remote', 'get-url', 'origin'], { cwd: repository })
  if (result.code !== 0) {
    throw new Error('Could not read the `origin` remote. Pass --repo owner/name.')
  }

  const url = result.stdout.trim()
  const match = /github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/.exec(url)
  if (match === null) throw new Error(`Could not read owner/name out of the origin remote: ${url}`)

  return `${match[1]}/${match[2]}`
}

async function detectDefaultBranch(repository: string, repo: string): Promise<string> {
  const result = await run(
    'gh',
    ['repo', 'view', repo, '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name'],
    { cwd: repository, timeoutMs: 60_000, envProfile: 'github' },
  )
  const branch = result.stdout.trim()
  if (result.code !== 0 || branch === '') {
    throw new Error('Could not read the default branch from GitHub.')
  }
  return branch
}

async function loadPolicy(repository: string) {
  return parsePolicy(
    JSON.parse(await readFile(join(repository, '.github', 'loop-policy.json'), 'utf8')),
  )
}

async function status(
  repository: string,
  repo: string,
  lockPath: string,
  args: Args,
): Promise<number> {
  const config = applyFlags(loadConfig(), args)
  const checks = await preflight({ repository, lockPath, repo })
  const limit = issueBudget(config)

  log(`Repository    ${repo}`)
  log(`Branch        ${await currentBranch(repository)}`)
  log(`Mode          ${config.LOOP_UNATTENDED ? 'unattended' : 'attended'}`)
  log(`Runner        ${checks.lock === null ? 'stopped' : `running (pid ${checks.lock.pid})`}`)
  log(formatPreflight(checks))
  log('')
  log('Limits:')
  log(`  issues this run      ${limit === 0 ? 'unlimited' : limit}`)
  log(`  coding fix rounds    ${config.LOOP_CODING_FIX_ROUNDS}`)
  log(`  review fix rounds    ${config.LOOP_REVIEW_FIX_ROUNDS}`)
  log(`  CI fix rounds        ${config.LOOP_CI_FIX_ROUNDS}`)
  log(`  reviewer retries     ${config.LOOP_REVIEWER_RETRY_ROUNDS}`)
  log(`  model calls per hour ${config.LOOP_MAX_MODEL_INVOCATIONS_PER_HOUR || 'unlimited'}`)
  log(`  issues per day       ${config.LOOP_MAX_ISSUES_PER_DAY || 'unlimited'}`)
  log(`  session runtime      ${config.LOOP_MAX_RUNTIME_HOURS || 'unlimited'}h`)

  const journal = await readJournal(journalPath(repository))
  const open = inFlight(journal)
  log('')

  if (open.length === 0) {
    log('Current       nothing in flight')
  } else {
    log('Current:')
    for (const record of open) {
      const phase =
        record.pullRequest === null
          ? record.status === 'in-progress'
            ? 'coding'
            : 'preparing'
          : 'waiting-ci'
      const risk = record.risk === null ? '' : ` [${record.risk}]`
      log(`  #${record.issue}${risk} phase=${phase} branch=${record.branch}`)
    }
  }

  const done = journal.runs.filter((record) => record.status === 'done')
  const blocked = journal.runs.filter((record) => record.status === 'blocked')
  if (done.length > 0) {
    log('')
    log(`Completed this journal: ${done.map((record) => `#${record.issue}`).join(', ')}`)
  }
  if (blocked.length > 0) {
    log(`Blocked:                ${blocked.map((record) => `#${record.issue}`).join(', ')}`)
  }

  if (!checks.gh.available) {
    log('')
    log('External blockers:')
    for (const problem of checks.problems) log(`  - ${problem}`)
    return 1
  }

  const gh = createGhClient({ repo, cwd: repository })
  const policy = await loadPolicy(repository)

  for (const record of open) {
    if (record.pullRequest === null) continue
    const pullRequest = await gh.pullRequest(record.pullRequest)
    const { verdict, failing } = summariseChecks(pullRequest)
    const failed = failing.length === 0 ? '' : ` (${failing.join(', ')})`
    log(
      `  PR #${record.pullRequest}: ${pullRequest.state.toLowerCase()}, checks ${verdict}${failed}, merge ${pullRequest.mergeStateStatus ?? 'unknown'}`,
    )
  }

  const ready = await gh.issues(['agent:ready'])
  log('')
  if (ready.length === 0) log('Eligible next: nothing carries agent:ready')
  else {
    log('Eligible next:')
    for (const issue of ready.slice(0, 10)) {
      const names = issue.labels.map((label) => label.name)
      const risk = names.find((name) => name.startsWith('risk:'))
      const reviewers = risk === 'risk:high' ? reviewersForRisk(policy, 'high') : 1
      log(
        `  #${issue.number} ${issue.title}${risk === undefined ? '' : ` [${risk}, ${reviewers} reviewer(s)]`}`,
      )
    }
  }

  if (checks.problems.length > 0) {
    log('')
    log('External blockers:')
    for (const problem of checks.problems) log(`  - ${problem}`)
  }

  return checks.ok ? 0 : 1
}

async function writeSummary(repository: string, summary: RunSummary): Promise<void> {
  const directory = join(repository, '.loop')
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'last-run.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8')
}

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2))

  if ('help' in parsed) {
    log(usage())
    return 0
  }
  if ('error' in parsed) {
    log(parsed.error)
    log('')
    log(usage())
    return 2
  }

  const repository = await repositoryRoot(process.cwd())
  const lockPath = join(repository, '.loop', 'runner.lock')
  const config = applyFlags(loadConfig(), parsed)
  const repo = parsed.repo ?? (await detectRepo(repository))

  if (parsed.command === 'status') return status(repository, repo, lockPath, parsed)

  const checks = await preflight({ repository, lockPath, repo })
  if (!checks.ok) {
    log(formatPreflight(checks))
    log('')
    // Stopping here is the point: no issue has been claimed, so there is
    // nothing to unwind and nothing left labelled `agent:in-progress`.
    log('Refusing to start. Fix the problems above.')
    return 1
  }
  for (const warning of checks.warnings) log(`warning: ${warning}`)

  const gh = createGhClient({ repo, cwd: repository })
  const agentOptions = {
    timeoutMs: config.LOOP_AGENT_TIMEOUT_MINUTES * 60_000,
    model: config.LOOP_AGENT_MODEL,
    onLog: log,
  }

  if (parsed.command === 'review') {
    const number = Number(parsed.positional[0])
    if (!Number.isInteger(number) || number <= 0) {
      log('`review` needs a pull request number.')
      return 2
    }

    const result = await reviewPullRequest(
      {
        gh,
        review: new ClaudeCodeReviewAgent(agentOptions),
        repository,
        policyPath: join(repository, '.github', 'loop-policy.json'),
        log,
        publish: !parsed.dryRun,
      },
      number,
    )

    if (result.review === null) {
      log(result.detail)
      return 1
    }
    log(renderReview(result.review))
    log('')
    log(result.detail)
    return 0
  }

  const budget = new Budget(config)
  const deps: RunnerDeps = {
    config,
    policy: await loadPolicy(repository),
    repository,
    repo,
    remote: 'origin',
    defaultBranch: await detectDefaultBranch(repository, repo),
    gh,
    coding: new ClaudeCodeCodingAgent(agentOptions),
    // Two reviewer objects, so the high-risk tier gets two Claude Code
    // invocations that share no session. Reviewer B optionally runs a different
    // model, which is extra diversity rather than a requirement.
    reviewers: [
      new ClaudeCodeReviewAgent(agentOptions),
      new ClaudeCodeReviewAgent({
        ...agentOptions,
        model: config.LOOP_REVIEWER_B_MODEL || config.LOOP_AGENT_MODEL,
      }),
    ],
    log,
    budget,
  }

  if (parsed.dryRun) {
    const plan = await planDryRun(deps)
    const limit = issueBudget(config)

    log(`Repository    ${repo} (default branch ${deps.defaultBranch})`)
    log(`Mode          ${config.LOOP_UNATTENDED ? 'unattended' : 'attended'}`)
    log(`Ceiling       ${limit === 0 ? 'unlimited' : `${limit} issue(s)`}`)
    log(
      plan.inFlight.length === 0
        ? 'In flight     nothing'
        : `In flight     ${plan.inFlight.map((record) => `#${record.issue}`).join(', ')}`,
    )
    log('')
    log('Planned execution order:')
    for (const entry of plan.order.slice(0, 15)) {
      log(`  ${entry.eligible ? '->' : '  '} #${entry.issue} ${entry.title} — ${entry.reason}`)
    }

    if (plan.selected !== null) {
      log('')
      log(`First          #${plan.selected.number} ${plan.selected.title}`)
      log(`Branch         ${plan.branch}`)
      log(`Worktree       ${plan.worktree}`)
      log(`Claude         ${plan.command}`)
      log(`Verification   the tier for its risk, from .github/loop-policy.json`)
      log(`PR             opened with \`Closes #${plan.selected.number}\`, then agent:review`)
      log(`Merge          GitHub auto-merge, once its required checks pass`)
    } else {
      log('')
      log(`Nothing to select — ${plan.stopReason ?? 'no issue is ready'}`)
    }

    log('')
    log('Dry run: no label, branch, worktree, commit, push, comment or pull request was created.')
    return 0
  }

  // `once` and `watch` mutate GitHub, so they take the lock.
  const lock = await acquireLock(lockPath, parsed.command)
  if (!lock.acquired) {
    log(lock.reason)
    return 1
  }

  // A closed terminal must not leave the lock behind, and an interrupted
  // unattended session must still print what it did.
  let stopping = false
  const release = () => {
    if (stopping) return
    stopping = true
    log('\nStopping after the current step…')
  }
  process.on('SIGINT', release)
  process.on('SIGTERM', release)

  try {
    if (parsed.command === 'once') {
      const result = await runOnce(deps)
      for (const outcome of result.outcomes) {
        log(`#${outcome.issue}: ${outcome.status} — ${outcome.detail}`)
      }
      log(result.detail)
      return result.stopReason === 'blocked' ? 1 : 0
    }

    const { summary, stopReason } = await runUnattended(deps, { stopping: () => stopping })
    await writeSummary(repository, summary)
    log(formatSummary(summary))
    log(`Summary written to .loop/last-run.json`)

    // A loop that ran out of work did its job. One that ran out of budget, or
    // lost GitHub, did not — and the exit code should say which.
    return ['nothing-ready', 'max-issues-reached', 'interrupted'].includes(stopReason) ? 0 : 1
  } finally {
    await lock.release()
  }
}

// Surfaced rather than swallowed: an unexpected failure in an autonomous runner
// is exactly the thing that must not look like a quiet success. Guarded so the
// tests can import `parseArgs` without starting a run.
if (import.meta.main) {
  main()
    .then((code) => {
      process.exit(code)
    })
    .catch((error: unknown) => {
      log(`Runner failed: ${redact(error instanceof Error ? error.message : String(error))}`)
      process.exit(1)
    })
}
