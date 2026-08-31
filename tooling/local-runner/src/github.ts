import { z } from 'zod'
import { type RunResult, resolveOnPath, run } from './exec.ts'
import { redact } from './redact.ts'

/**
 * The GitHub side of the runner, spoken through the `gh` CLI.
 *
 * `gh` is used rather than a token in this process on purpose: the developer
 * has already authenticated it, the runner never has to read, hold or print a
 * credential, and revoking access is something they do in one place.
 *
 * Everything read back through here is untrusted. Issue bodies, titles, review
 * comments and check names are written by whoever can open an issue. They are
 * data for prompts and reports, never instructions to the runner.
 */

export type GhAvailability =
  | {
      available: false
      reason:
        | 'not-installed'
        | 'not-authenticated'
        | 'no-repository-access'
        | 'insufficient-permissions'
      remedy: string
      detail?: string
    }
  | { available: true; account: string; repository: string; capabilities: Capabilities }

/**
 * What this credential can actually do to this repository.
 *
 * Read from `repos/{owner}/{name}`, which reports the authenticated user's
 * permissions without mutating anything. Probing by attempting a write would
 * leave litter in the issue tracker of a repository the runner may not even be
 * cleared to work on.
 */
export interface Capabilities {
  read: boolean
  /** Covers creating branches, pushing, and opening pull requests. */
  push: boolean
  /** Covers labelling and commenting on issues. */
  triage: boolean
  admin: boolean
}

const CAPABILITY_SCHEMA = z.object({
  pull: z.boolean().default(false),
  push: z.boolean().default(false),
  triage: z.boolean().default(false),
  admin: z.boolean().default(false),
  maintain: z.boolean().default(false),
})

export interface GhOptions {
  runner?: typeof run
  which?: (command: string) => string | null
  cwd?: string
  /** `owner/name`. Access to it is verified, not assumed. */
  repo?: string
}

/**
 * Establish that `gh` can actually do this repository's work.
 *
 * Being logged in is not the same as being able to read the repository, and the
 * difference is expensive: a probe that stops at `gh auth status` reports ready,
 * the runner claims an issue, and the first repository call fails with the issue
 * already labelled `agent:in-progress` and a worktree half built. So the probe
 * makes a real repository call and treats anything but success as not ready.
 */
export async function probeGh(options: GhOptions = {}): Promise<GhAvailability> {
  const exec = options.runner ?? run
  const which = options.which ?? resolveOnPath

  if (which('gh') === null) {
    return {
      available: false,
      reason: 'not-installed',
      remedy: 'Install the GitHub CLI (https://cli.github.com) and make sure `gh` is on PATH.',
    }
  }

  const status = await exec('gh', ['auth', 'status'], {
    timeoutMs: 30_000,
    cwd: options.cwd,
    envProfile: 'github',
  })
  if (status.code !== 0) {
    return {
      available: false,
      reason: 'not-authenticated',
      remedy: 'Run `gh auth login`. The runner never handles the token itself.',
    }
  }

  const account = await exec('gh', ['api', 'user', '--jq', '.login'], {
    timeoutMs: 30_000,
    cwd: options.cwd,
    envProfile: 'github',
  })
  if (account.code !== 0) {
    return {
      available: false,
      reason: 'not-authenticated',
      remedy: 'Run `gh auth login`; the credential `gh` holds was rejected.',
      detail: redact(account.stderr.trim()).slice(0, 500),
    }
  }

  if (options.repo === undefined) {
    return {
      available: true,
      account: account.stdout.trim() || 'unknown',
      repository: '(unchecked)',
      capabilities: { read: true, push: true, triage: true, admin: false },
    }
  }

  // One call that proves read access *and* reports what this credential may do,
  // without mutating anything. Probing writes by attempting one would leave
  // litter in the issue tracker of a repository the runner may not be cleared
  // to work on.
  const repository = await exec(
    'gh',
    ['api', `repos/${options.repo}`, '--jq', '{full_name: .full_name, permissions: .permissions}'],
    { timeoutMs: 30_000, cwd: options.cwd, envProfile: 'github' },
  )
  if (repository.code !== 0 || repository.stdout.trim() === '') {
    return {
      available: false,
      reason: 'no-repository-access',
      remedy: `\`gh\` is authenticated as ${account.stdout.trim() || 'an unknown account'} but cannot read ${options.repo}. Check the account has access, and that any proxy or policy in front of the GitHub API allows repository calls.`,
      detail: redact(repository.stderr.trim() || repository.stdout.trim()).slice(0, 500),
    }
  }

  const described = z
    .object({ full_name: z.string(), permissions: CAPABILITY_SCHEMA.optional() })
    .safeParse(safeJson(repository.stdout))

  if (!described.success) {
    return {
      available: false,
      reason: 'no-repository-access',
      remedy: `\`gh\` returned a description of ${options.repo} the runner could not read.`,
      detail: described.error.issues
        .map((issue) => issue.message)
        .join('; ')
        .slice(0, 500),
    }
  }

  const granted = described.data.permissions
  const capabilities: Capabilities = {
    read: granted?.pull ?? true,
    push: granted?.push ?? false,
    triage: (granted?.triage ?? false) || (granted?.push ?? false),
    admin: granted?.admin ?? false,
  }

  // Claiming an issue the runner cannot later label, or building a branch it
  // cannot push, wastes an agent invocation and leaves the backlog dirty. Both
  // are cheap to rule out before any of that happens.
  const missing: string[] = []
  if (!capabilities.push) missing.push('push (branches and pull requests)')
  if (!capabilities.triage) missing.push('triage (issue labels and comments)')

  if (missing.length > 0) {
    return {
      available: false,
      reason: 'insufficient-permissions',
      remedy: `\`gh\` can read ${options.repo} as ${account.stdout.trim() || 'an unknown account'} but lacks: ${missing.join(', ')}. The loop needs both to claim an issue and open a pull request.`,
    }
  }

  return {
    available: true,
    account: account.stdout.trim() || 'unknown',
    repository: described.data.full_name,
    capabilities,
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

export const issueSchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  body: z.string().nullish(),
  state: z.string(),
  labels: z.array(z.object({ name: z.string() })).default([]),
})
export type GhIssue = z.infer<typeof issueSchema>

export const checkSchema = z.object({
  name: z.string().nullish(),
  context: z.string().nullish(),
  status: z.string().nullish(),
  conclusion: z.string().nullish(),
  state: z.string().nullish(),
})

export const pullRequestSchema = z.object({
  number: z.number().int().positive(),
  state: z.string(),
  url: z.string(),
  isDraft: z.boolean().default(false),
  headRefName: z.string(),
  headRefOid: z.string().nullish(),
  mergeStateStatus: z.string().nullish(),
  reviewDecision: z.string().nullish(),
  statusCheckRollup: z.array(checkSchema).nullish(),
})
export type GhPullRequest = z.infer<typeof pullRequestSchema>

export class GhError extends Error {
  constructor(
    readonly args: readonly string[],
    readonly result: RunResult,
  ) {
    super(
      `gh ${args[0] ?? ''} failed (${result.code}): ${redact(result.stderr.trim() || result.stdout.trim()).slice(0, 500)}`,
    )
    this.name = 'GhError'
  }
}

/**
 * Everything the loop needs from GitHub, as an interface.
 *
 * The orchestrator talks to this and never to a shell. That is what keeps the
 * decision logic testable without a network, and what leaves room for another
 * execution environment later — a sandbox that exposes GitHub through something
 * other than the CLI implements this and changes nothing above it.
 *
 * `GhCliGitHubAdapter` is the one implementation, and the expected deployment
 * is a normal machine with real `gh` repository access.
 */
export interface GitHubAdapter {
  issues(labels: readonly string[]): Promise<GhIssue[]>
  issue(number: number): Promise<GhIssue>
  addLabels(issue: number, labels: readonly string[]): Promise<void>
  removeLabel(issue: number, label: string): Promise<void>
  comment(issue: number, body: string): Promise<void>
  createPullRequest(input: CreatePullRequestInput): Promise<number>
  pullRequest(number: number): Promise<GhPullRequest>
  pullRequestForBranch(branch: string): Promise<GhPullRequest | null>
  pullRequestComments(number: number): Promise<string[]>
  pullRequestDiff(number: number): Promise<string>
  /**
   * Ask GitHub to merge the pull request once its own required checks pass.
   *
   * Native auto-merge, deliberately: the runner states that the pull request is
   * ready and GitHub decides whether it actually is. There is no code path here
   * that merges anything, so a bug in the runner cannot produce a merge the
   * repository ruleset would have refused.
   */
  enableAutoMerge(number: number): Promise<void>
  /** Bring the pull request up to date with its base branch. */
  updateBranch(number: number): Promise<void>
  /** Re-run failed jobs for the checks on a pull request. */
  rerunFailedChecks(number: number): Promise<void>
  /** Whether the pull request is behind, conflicted, or clean. */
  mergeability(number: number): Promise<Mergeability>
}

/** Retained for callers written before the interface was named. */
export type GhClient = GitHubAdapter

export type Mergeability = 'clean' | 'behind' | 'conflicted' | 'blocked' | 'unknown'

export interface CreatePullRequestInput {
  base: string
  head: string
  title: string
  body: string
  draft?: boolean
}

export interface GhClientOptions {
  repo: string
  cwd?: string
  runner?: typeof run
  timeoutMs?: number
}

/**
 * The `gh` CLI implementation of {@link GitHubAdapter}.
 *
 * `--repo owner/name` is passed explicitly everywhere rather than relying on
 * the current directory, because the runner works out of worktrees and a
 * mis-detected remote would act on the wrong repository.
 */
export function createGhClient(options: GhClientOptions): GitHubAdapter {
  const exec = options.runner ?? run
  const timeoutMs = options.timeoutMs ?? 120_000

  async function gh(args: readonly string[], stdin?: string): Promise<string> {
    const result = await exec('gh', args, {
      cwd: options.cwd,
      timeoutMs,
      stdin,
      envProfile: 'github',
    })
    if (result.code !== 0) throw new GhError(args, result)
    return result.stdout
  }

  function parse<T>(schema: z.ZodType<T>, raw: string, what: string): T {
    let json: unknown
    try {
      json = JSON.parse(raw)
    } catch {
      throw new Error(`gh returned output for ${what} that was not JSON.`)
    }

    const parsed = schema.safeParse(json)
    if (!parsed.success) {
      throw new Error(
        `gh returned an unexpected shape for ${what}: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
      )
    }
    return parsed.data
  }

  return {
    async issues(labels) {
      const args = [
        'issue',
        'list',
        '--repo',
        options.repo,
        '--state',
        'open',
        '--limit',
        '200',
        '--json',
        'number,title,body,state,labels',
      ]
      for (const label of labels) args.push('--label', label)

      return parse(z.array(issueSchema), await gh(args), 'the issue list')
    },

    async issue(number) {
      const raw = await gh([
        'issue',
        'view',
        String(number),
        '--repo',
        options.repo,
        '--json',
        'number,title,body,state,labels',
      ])
      return parse(issueSchema, raw, `issue #${number}`)
    },

    async addLabels(issue, labels) {
      if (labels.length === 0) return
      const args = ['issue', 'edit', String(issue), '--repo', options.repo]
      for (const label of labels) args.push('--add-label', label)
      await gh(args)
    },

    async removeLabel(issue, label) {
      // A label that is not present is not an error worth stopping for.
      const result = await exec(
        'gh',
        ['issue', 'edit', String(issue), '--repo', options.repo, '--remove-label', label],
        { cwd: options.cwd, timeoutMs, envProfile: 'github' },
      )
      if (result.code !== 0 && !/not found|does not have/i.test(result.stderr)) {
        throw new GhError(['issue', 'edit'], result)
      }
    },

    async comment(issue, body) {
      // Through stdin: comment bodies carry agent output and issue text, and
      // keeping them off argv keeps them out of process listings too.
      await gh(
        ['issue', 'comment', String(issue), '--repo', options.repo, '--body-file', '-'],
        body,
      )
    },

    async createPullRequest(input) {
      const args = [
        'pr',
        'create',
        '--repo',
        options.repo,
        '--base',
        input.base,
        '--head',
        input.head,
        '--title',
        input.title,
        '--body-file',
        '-',
      ]
      if (input.draft === true) args.push('--draft')

      const url = (await gh(args, input.body)).trim()
      const number = /\/pull\/(\d+)\s*$/.exec(url)?.[1]
      if (number === undefined) {
        throw new Error(`Could not read a pull request number out of: ${url}`)
      }
      return Number(number)
    },

    async pullRequest(number) {
      const raw = await gh([
        'pr',
        'view',
        String(number),
        '--repo',
        options.repo,
        '--json',
        'number,state,url,isDraft,headRefName,headRefOid,mergeStateStatus,reviewDecision,statusCheckRollup',
      ])
      return parse(pullRequestSchema, raw, `pull request #${number}`)
    },

    async pullRequestForBranch(branch) {
      const raw = await gh([
        'pr',
        'list',
        '--repo',
        options.repo,
        '--head',
        branch,
        '--state',
        'all',
        '--limit',
        '1',
        '--json',
        'number,state,url,isDraft,headRefName,headRefOid,mergeStateStatus,reviewDecision,statusCheckRollup',
      ])
      const list = parse(z.array(pullRequestSchema), raw, `pull requests for ${branch}`)
      return list[0] ?? null
    },

    async pullRequestComments(number) {
      const raw = await gh([
        'pr',
        'view',
        String(number),
        '--repo',
        options.repo,
        '--json',
        'comments',
      ])
      const parsed = parse(
        z.object({ comments: z.array(z.object({ body: z.string() })).default([]) }),
        raw,
        `comments on #${number}`,
      )
      return parsed.comments.map((comment) => comment.body)
    },

    async pullRequestDiff(number) {
      return gh(['pr', 'diff', String(number), '--repo', options.repo])
    },

    async enableAutoMerge(number) {
      // `--squash` matches this repository's convention; `--auto` is the whole
      // point — GitHub merges when *its* required checks pass, not when the
      // runner says so.
      await gh(['pr', 'merge', String(number), '--repo', options.repo, '--squash', '--auto'])
    },

    async updateBranch(number) {
      await gh(['pr', 'update-branch', String(number), '--repo', options.repo])
    },

    async rerunFailedChecks(number) {
      const raw = await gh([
        'pr',
        'view',
        String(number),
        '--repo',
        options.repo,
        '--json',
        'statusCheckRollup',
      ])

      const parsed = parse(
        z.object({
          statusCheckRollup: z.array(z.object({ detailsUrl: z.string().nullish() })).nullish(),
        }),
        raw,
        `checks on #${number}`,
      )

      const runIds = new Set<string>()
      for (const check of parsed.statusCheckRollup ?? []) {
        const match = /\/actions\/runs\/(\d+)/.exec(check.detailsUrl ?? '')
        if (match?.[1] !== undefined) runIds.add(match[1])
      }

      for (const runId of runIds) {
        // Best effort: a run that cannot be re-run is not worth stopping for.
        await exec('gh', ['run', 'rerun', runId, '--repo', options.repo, '--failed'], {
          cwd: options.cwd,
          timeoutMs,
          envProfile: 'github',
        })
      }
    },

    async mergeability(number) {
      const pullRequest = await this.pullRequest(number)
      const status = (pullRequest.mergeStateStatus ?? '').toUpperCase()

      if (status === 'DIRTY') return 'conflicted'
      if (status === 'BEHIND') return 'behind'
      if (status === 'CLEAN' || status === 'HAS_HOOKS' || status === 'UNSTABLE') return 'clean'
      if (status === 'BLOCKED') return 'blocked'
      return 'unknown'
    },
  }
}

/** Check-run rollup reduced to what the runner needs to decide whether to wait. */
export type ChecksVerdict = 'pending' | 'passing' | 'failing' | 'none'

export function summariseChecks(pullRequest: GhPullRequest): {
  verdict: ChecksVerdict
  failing: string[]
} {
  const checks = pullRequest.statusCheckRollup ?? []
  if (checks.length === 0) return { verdict: 'none', failing: [] }

  const failing: string[] = []
  let pending = false

  for (const check of checks) {
    const name = check.name ?? check.context ?? 'unnamed check'
    // Check runs report `status`/`conclusion`; commit statuses report `state`.
    const conclusion = (check.conclusion ?? check.state ?? '').toUpperCase()
    const status = (check.status ?? '').toUpperCase()

    if (status !== '' && status !== 'COMPLETED') {
      pending = true
      continue
    }
    if (conclusion === 'PENDING' || conclusion === 'EXPECTED' || conclusion === '') {
      pending = true
      continue
    }
    if (['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(conclusion)) continue

    failing.push(name)
  }

  if (failing.length > 0) return { verdict: 'failing', failing }
  return { verdict: pending ? 'pending' : 'passing', failing: [] }
}
