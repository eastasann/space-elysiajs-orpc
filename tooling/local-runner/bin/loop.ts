#!/usr/bin/env bun
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parsePolicy } from '@newsdeck/loop'
import { ClaudeCodeCodingAgent, ClaudeCodeReviewAgent } from '../src/claude-agent.ts'
import { loadConfig } from '../src/config.ts'
import { run } from '../src/exec.ts'
import { currentBranch, repositoryRoot } from '../src/git.ts'
import { createGhClient, summariseChecks } from '../src/github.ts'
import { readJournal } from '../src/journal.ts'
import { acquireLock } from '../src/lock.ts'
import {
  advance,
  inFlight,
  journalPath,
  planDryRun,
  type RunnerDeps,
  runOnce,
} from '../src/orchestrator.ts'
import { formatPreflight, preflight } from '../src/preflight.ts'
import { redact } from '../src/redact.ts'
import { renderReview, reviewPullRequest } from '../src/review-command.ts'

/**
 * `bun run loop:<command>`.
 *
 * Four commands, and only two of them change anything: `status` reports,
 * `review` comments, `once` takes an issue, `watch` repeats `once`. Nothing
 * here merges — that is the GitHub gate's job, and the runner has no path to it.
 */

const COMMANDS = ['status', 'once', 'watch', 'review'] as const
type Command = (typeof COMMANDS)[number]

function usage(): string {
  return [
    'Usage: bun tooling/local-runner/bin/loop.ts <command> [options]',
    '',
    'Commands:',
    '  status              Report readiness, the lock, and what the runner would pick up',
    '  once                Take the next ready issue through to a pull request',
    '  watch               Drive open work forward and take new issues, on an interval',
    '  review <number>     Post an advisory review on a pull request',
    '',
    'Options:',
    '  --dry-run           Report what would happen; change nothing, invoke no agent',
    '  --repo owner/name   Override the repository (defaults to the git remote)',
    '  --help',
    '',
    'Configuration comes from the environment; see docs/local-agent-runner.md.',
  ].join('\n')
}

interface Args {
  command: Command
  dryRun: boolean
  repo: string | null
  positional: string[]
}

export function parseArgs(argv: readonly string[]): Args | { help: true } | { error: string } {
  const positional: string[] = []
  let dryRun = false
  let repo: string | null = null

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] as string
    if (arg === '--help' || arg === '-h') return { help: true }
    if (arg === '--dry-run') dryRun = true
    else if (arg === '--repo') {
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

  return { command: command as Command, dryRun, repo, positional }
}

const log = (line: string) => {
  process.stdout.write(`${redact(line)}\n`)
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
    { cwd: repository, timeoutMs: 60_000 },
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

async function status(repository: string, repo: string, lockPath: string): Promise<number> {
  const config = loadConfig()
  const checks = await preflight({ repository, lockPath, repo })

  log(`Repository    ${repo}`)
  log(`Branch        ${await currentBranch(repository)}`)
  log(formatPreflight(checks))
  log('')
  log('Limits:')
  log(
    `  max issues per run   ${config.LOOP_MAX_ISSUES === 0 ? 'unlimited (opted in)' : config.LOOP_MAX_ISSUES}`,
  )
  log(`  coding fix rounds    ${config.LOCAL_AGENT_MAX_FIX_ROUNDS}`)
  log(`  agent timeout        ${config.LOOP_AGENT_TIMEOUT_MINUTES} min`)

  const journal = await readJournal(journalPath(repository))
  const open = inFlight(journal)
  log('')
  log(open.length === 0 ? 'Current:      nothing in flight' : 'Current:')
  for (const record of open) {
    const pr = record.pullRequest === null ? 'no pull request yet' : `PR #${record.pullRequest}`
    log(`  #${record.issue} ${record.status} — ${pr} (${record.branch})`)
  }

  if (!checks.gh.available) return checks.ok ? 0 : 1

  const gh = createGhClient({ repo, cwd: repository })

  for (const record of open) {
    if (record.pullRequest === null) continue
    const pullRequest = await gh.pullRequest(record.pullRequest)
    const { verdict, failing } = summariseChecks(pullRequest)
    const failed = failing.length === 0 ? '' : ` (${failing.join(', ')})`
    log(
      `  PR #${record.pullRequest}: ${pullRequest.state.toLowerCase()}, checks ${verdict}${failed}, review ${pullRequest.reviewDecision ?? 'none'}`,
    )
  }

  const ready = await gh.issues(['agent:ready'])
  log('')
  if (ready.length === 0) log('Eligible:     nothing carries agent:ready')
  else {
    log('Eligible:')
    for (const issue of ready.slice(0, 10)) {
      const risk = issue.labels.map((label) => label.name).find((name) => name.startsWith('risk:'))
      log(`  #${issue.number} ${issue.title}${risk === undefined ? '' : ` [${risk}]`}`)
    }
  }

  return checks.ok ? 0 : 1
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
  const config = loadConfig()
  const repo = parsed.repo ?? (await detectRepo(repository))

  if (parsed.command === 'status') return status(repository, repo, lockPath)

  const checks = await preflight({ repository, lockPath, repo })
  if (!checks.ok) {
    log(formatPreflight(checks))
    log('')
    // Stopping here is the point: the issue has not been claimed, so there is
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

  const deps: RunnerDeps = {
    config,
    policy: await loadPolicy(repository),
    repository,
    repo,
    remote: 'origin',
    defaultBranch: await detectDefaultBranch(repository, repo),
    gh,
    coding: new ClaudeCodeCodingAgent(agentOptions),
    review: new ClaudeCodeReviewAgent(agentOptions),
    log,
  }

  if (parsed.dryRun) {
    const plan = await planDryRun(deps)
    log(`Repository    ${repo} (default branch ${deps.defaultBranch})`)
    log(
      plan.inFlight.length === 0
        ? 'In flight     nothing'
        : `In flight     ${plan.inFlight.map((record) => `#${record.issue}`).join(', ')}`,
    )
    if (plan.selected === null) {
      log(`Selection     none — ${plan.stopReason ?? 'nothing is ready'}`)
    } else {
      log(`Selection     #${plan.selected.number} ${plan.selected.title}`)
      log(`Branch        ${plan.branch}`)
      log(`Worktree      ${plan.worktree}`)
      log(`Claude        ${plan.command}`)
      log(`Verification  ${plan.verification.join(', ')}`)
      log(
        'PR            would be created with `Closes #' +
          plan.selected.number +
          '`, then agent:review',
      )
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

  // A terminal closed mid-run must not leave the lock behind.
  let stopping = false
  const release = () => {
    stopping = true
    void lock.release().then(() => process.exit(130))
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

    log(`Watching ${repo}; polling every ${config.LOOP_POLL_INTERVAL_SECONDS}s. Ctrl-C to stop.`)
    let taken = 0

    while (!stopping) {
      for (const outcome of await advance(deps)) {
        log(`#${outcome.issue}: ${outcome.action} — ${outcome.detail}`)
        if (outcome.action === 'retries-exhausted') {
          log('Stopping: the retry budget is spent and the issue needs a human.')
          return 1
        }
      }

      const journal = await readJournal(journalPath(repository))
      if (inFlight(journal).length === 0) {
        if (config.LOOP_MAX_ISSUES !== 0 && taken >= config.LOOP_MAX_ISSUES) {
          log(`Stopping: LOOP_MAX_ISSUES=${config.LOOP_MAX_ISSUES} reached.`)
          return 0
        }

        const result = await runOnce(deps)
        for (const outcome of result.outcomes) {
          log(`#${outcome.issue}: ${outcome.status} — ${outcome.detail}`)
        }
        if (result.outcomes.length > 0) taken += 1

        if (result.stopReason === 'blocked') {
          log('Stopping: an issue is blocked and needs a human.')
          return 1
        }
        if (result.stopReason === 'nothing-ready') log(result.detail)
      }

      await Bun.sleep(config.LOOP_POLL_INTERVAL_SECONDS * 1000)
    }

    return 0
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
