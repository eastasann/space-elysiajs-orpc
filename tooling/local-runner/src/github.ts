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
  | { available: false; reason: 'not-installed' | 'not-authenticated'; remedy: string }
  | { available: true; account: string }

export interface GhOptions {
  runner?: typeof run
  which?: (command: string) => string | null
  cwd?: string
}

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

  return { available: true, account: account.stdout.trim() || 'unknown' }
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
 * A `gh` invocation bound to one repository.
 *
 * `--repo owner/name` is passed explicitly everywhere rather than relying on
 * the current directory, because the runner works out of worktrees and a
 * mis-detected remote would act on the wrong repository.
 */
export interface GhClient {
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
}

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

export function createGhClient(options: GhClientOptions): GhClient {
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
