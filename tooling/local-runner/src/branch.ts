/**
 * Deterministic branch and worktree naming.
 *
 * The name is derived from the issue, not from anything the agent chooses, so
 * a resumed run finds the branch it created last time and a second runner
 * cannot invent a parallel one. The title is untrusted input: it is reduced to
 * `[a-z0-9-]` rather than escaped, which removes the entire class of "what does
 * git do with this character" question.
 */

const MAX_SLUG_LENGTH = 40

export function slugify(title: string): string {
  const slug = title
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    // Truncate at a separator rather than mid-word, so `...-evil-tes` does not
    // end up in a branch name a human has to read.
    .replace(new RegExp(`^(.{0,${MAX_SLUG_LENGTH}})(-.*)?$`, 's'), '$1')
    .replace(/-+$/g, '')

  return slug === '' ? 'issue' : slug
}

/** `agent/issue-42-short-description`. Stable for a given issue and title. */
export function branchName(issue: number, title: string): string {
  return `agent/issue-${issue}-${slugify(title)}`
}

/** Directory name for the isolated worktree. One per issue, never shared. */
export function worktreeName(issue: number): string {
  return `issue-${issue}`
}

/**
 * Whether a branch is one this runner is allowed to touch.
 *
 * The runner pushes only to branches it owns. `main`, release branches and a
 * developer's own work are out of scope by construction rather than by care.
 */
export function isAgentBranch(branch: string): boolean {
  return /^agent\/issue-[0-9]+-[a-z0-9-]+$/.test(branch)
}
