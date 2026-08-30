import { type ClaudeAvailability, probeClaude } from './claude.ts'
import { isClean } from './git.ts'
import { type GhAvailability, probeGh } from './github.ts'
import { type LockFile, readLock } from './lock.ts'

/**
 * Everything that has to be true before the runner touches an issue.
 *
 * Checked up front and reported together. A runner that discovers halfway
 * through that `gh` is not logged in has already claimed an issue and created a
 * branch, and someone has to clean that up by hand.
 */

export interface Preflight {
  claude: ClaudeAvailability
  gh: GhAvailability
  worktreeClean: boolean
  lock: LockFile | null
  ok: boolean
  problems: string[]
  warnings: string[]
}

export interface PreflightOptions {
  repository: string
  lockPath: string
}

export async function preflight(options: PreflightOptions): Promise<Preflight> {
  const [claude, gh, worktreeClean, lock] = await Promise.all([
    probeClaude(),
    probeGh({ cwd: options.repository }),
    isClean(options.repository),
    readLock(options.lockPath),
  ])

  const problems: string[] = []
  const warnings: string[] = []

  if (!claude.available) problems.push(`Claude Code: ${claude.reason}. ${claude.remedy}`)
  else if (claude.warning !== undefined) warnings.push(claude.warning)

  if (!gh.available) problems.push(`GitHub CLI: ${gh.reason}. ${gh.remedy}`)

  if (!worktreeClean) {
    // The runner works in its own worktree, so this is not fatal — but a dirty
    // main checkout usually means the developer has work in flight, and a
    // background agent starting now is the wrong surprise.
    warnings.push(
      'The main checkout has uncommitted changes. The runner works in a separate worktree and will not touch them.',
    )
  }

  if (lock !== null) problems.push(`A runner lock is present (pid ${lock.pid} on ${lock.host}).`)

  if (claude.available && !claude.subscription && claude.warning === undefined) {
    warnings.push(
      `Claude Code is authenticated with \`${claude.authMethod}\` rather than a subscription login. Runs will bill whatever that credential bills.`,
    )
  }

  return { claude, gh, worktreeClean, lock, problems, warnings, ok: problems.length === 0 }
}

export function formatPreflight(result: Preflight): string {
  const lines: string[] = []

  lines.push(
    result.claude.available
      ? `Claude Code   ok (${result.claude.version}, auth: ${result.claude.authMethod}${result.claude.subscription ? ', subscription' : ''})`
      : `Claude Code   NOT READY (${result.claude.reason})`,
  )
  lines.push(
    result.gh.available
      ? `GitHub CLI    ok (${result.gh.account})`
      : `GitHub CLI    NOT READY (${result.gh.reason})`,
  )
  lines.push(`Main checkout ${result.worktreeClean ? 'clean' : 'has uncommitted changes'}`)
  lines.push(
    result.lock === null
      ? 'Runner lock   free'
      : `Runner lock   held by pid ${result.lock.pid} on ${result.lock.host} since ${result.lock.startedAt}`,
  )

  if (result.problems.length > 0) {
    lines.push('', 'Problems:')
    for (const problem of result.problems) lines.push(`  - ${problem}`)
  }
  if (result.warnings.length > 0) {
    lines.push('', 'Warnings:')
    for (const warning of result.warnings) lines.push(`  - ${warning}`)
  }

  return lines.join('\n')
}
