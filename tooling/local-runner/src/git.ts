import { isAgentBranch } from './branch.ts'
import { type RunResult, run } from './exec.ts'

/**
 * Git operations the runner performs, and the boundaries it will not cross.
 *
 * Every call goes through `run`, so nothing reaches a shell. The guards here
 * exist because the runner drives an agent: a mistake is not a typo but an
 * autonomous process, and the cheapest place to stop it is before the push.
 */

export type Git = (args: readonly string[]) => Promise<RunResult>

export function gitIn(cwd: string): Git {
  // The `git` profile carries the ssh agent socket so a push can authenticate,
  // and no API credential at all.
  return (args) => run('git', args, { cwd, timeoutMs: 300_000, envProfile: 'git' })
}

async function expect(git: Git, args: readonly string[]): Promise<string> {
  const result = await git(args)
  if (result.code !== 0) {
    throw new Error(`git ${args[0]} failed: ${result.stderr.trim() || result.stdout.trim()}`)
  }
  return result.stdout.trim()
}

export async function repositoryRoot(cwd: string): Promise<string> {
  return expect(gitIn(cwd), ['rev-parse', '--show-toplevel'])
}

export async function currentBranch(cwd: string): Promise<string> {
  return expect(gitIn(cwd), ['rev-parse', '--abbrev-ref', 'HEAD'])
}

/** True when the working tree has no uncommitted change, tracked or otherwise. */
export async function isClean(cwd: string): Promise<boolean> {
  const status = await expect(gitIn(cwd), ['status', '--porcelain'])
  return status === ''
}

export async function changedFiles(cwd: string, base: string): Promise<string[]> {
  const output = await expect(gitIn(cwd), ['diff', '--name-only', `${base}...HEAD`])
  return output === '' ? [] : output.split('\n')
}

export async function hasCommitsBeyond(cwd: string, base: string): Promise<boolean> {
  const count = await expect(gitIn(cwd), ['rev-list', '--count', `${base}..HEAD`])
  return Number(count) > 0
}

export interface WorktreeRequest {
  /** Absolute path of the main checkout. */
  repository: string
  /** Absolute path the worktree should live at. */
  path: string
  branch: string
  /** Remote-tracking ref the branch starts from, e.g. `origin/main`. */
  base: string
}

/**
 * Create — or re-attach to — the isolated worktree for one issue.
 *
 * Isolation is the point: the agent gets its own checkout, so a run cannot
 * disturb whatever the developer has open in their editor, and an abandoned run
 * leaves a directory rather than a dirty main checkout.
 */
export async function ensureWorktree(request: WorktreeRequest): Promise<{ created: boolean }> {
  if (!isAgentBranch(request.branch)) {
    throw new Error(`Refusing to create a worktree for a non-agent branch: ${request.branch}`)
  }

  const git = gitIn(request.repository)

  const existing = await git(['worktree', 'list', '--porcelain'])
  if (existing.code === 0 && existing.stdout.includes(`worktree ${request.path}\n`)) {
    return { created: false }
  }

  const branchExists = await git([
    'show-ref',
    '--verify',
    '--quiet',
    `refs/heads/${request.branch}`,
  ])
  const args =
    branchExists.code === 0
      ? ['worktree', 'add', request.path, request.branch]
      : ['worktree', 'add', '-b', request.branch, request.path, request.base]

  await expect(git, args)
  return { created: true }
}

export async function removeWorktree(repository: string, path: string): Promise<void> {
  // `--force` here discards the worktree's own uncommitted changes, which is
  // the intent when tearing down a finished run. It never touches the main
  // checkout, and refs are left alone.
  await gitIn(repository)(['worktree', 'remove', '--force', path])
}

export async function fetchBase(repository: string, remote: string, branch: string): Promise<void> {
  await expect(gitIn(repository), ['fetch', '--prune', remote, branch])
}

export interface CommitRequest {
  cwd: string
  message: string
}

/** Stage everything in the worktree and commit. Returns false when nothing changed. */
export async function commitAll(request: CommitRequest): Promise<boolean> {
  const git = gitIn(request.cwd)
  await expect(git, ['add', '--all'])

  const staged = await git(['diff', '--cached', '--quiet'])
  if (staged.code === 0) return false

  // The message goes in as one argv element; there is no shell to interpret it.
  await expect(git, ['commit', '-m', request.message])
  return true
}

export interface PushRequest {
  cwd: string
  remote: string
  branch: string
}

/**
 * Push the agent branch.
 *
 * Never `--force`, and never any branch but the agent's own. The merge gate
 * lives on GitHub; this is the one place the runner could route around it, so
 * it is the one place that refuses.
 */
export async function pushBranch(request: PushRequest): Promise<RunResult> {
  if (!isAgentBranch(request.branch)) {
    throw new Error(
      `Refusing to push ${request.branch}. The runner pushes only agent/issue-* branches; merging into the default branch is the merge gate's job.`,
    )
  }

  return gitIn(request.cwd)(['push', '-u', request.remote, `${request.branch}:${request.branch}`])
}
