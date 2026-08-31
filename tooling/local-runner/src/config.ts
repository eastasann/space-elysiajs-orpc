import { z } from 'zod'

/**
 * Runner configuration.
 *
 * Two modes, and the difference is deliberate. Attended is the default: one
 * issue, then stop, so a first run cannot walk the backlog while nobody is
 * watching. Unattended is what this repository actually runs day to day, and
 * turning it on is an explicit act — `--unattended`, or `LOOP_UNATTENDED=true`.
 *
 * Unattended does not mean unbounded. Every limit below still applies; what
 * changes is that exhausting one blocks a single issue rather than stopping the
 * loop, and that the runner keeps selecting work until there is genuinely none.
 */
const truthy = z
  .union([z.boolean(), z.string()])
  .transform((value) =>
    typeof value === 'boolean' ? value : ['1', 'true', 'yes', 'on'].includes(value.toLowerCase()),
  )

export const runnerConfigSchema = z.object({
  /**
   * Unattended operation: keep taking issues until a global stop condition.
   *
   * Implies no per-run issue ceiling unless `LOOP_MAX_ISSUES` sets one.
   */
  LOOP_UNATTENDED: truthy.default(false),
  /**
   * Issues to take in one run.
   *
   * `0` means unlimited. The attended default of 1 is the whole safety story
   * for a first run; unattended defaults to unlimited, which is the point of
   * turning it on.
   */
  LOOP_MAX_ISSUES: z.coerce.number().int().min(0).max(1000).optional(),
  /** Implementation attempts against failing local verification. */
  LOOP_CODING_FIX_ROUNDS: z.coerce.number().int().min(1).max(10).default(3),
  /** Attempts at addressing review findings. */
  LOOP_REVIEW_FIX_ROUNDS: z.coerce.number().int().min(1).max(10).default(3),
  /** Attempts at addressing failing CI. */
  LOOP_CI_FIX_ROUNDS: z.coerce.number().int().min(1).max(10).default(3),
  /** Retries of a reviewer that returned unusable output. */
  LOOP_REVIEWER_RETRY_ROUNDS: z.coerce.number().int().min(1).max(5).default(2),
  /** Attempts at resolving a merge conflict. */
  LOOP_CONFLICT_ROUNDS: z.coerce.number().int().min(1).max(5).default(2),

  /** Where isolated worktrees are created, relative to the repository root. */
  LOOP_WORKTREE_ROOT: z.string().default('../.loop-worktrees'),
  /** Seconds between GitHub polls in watch mode. Deliberately unhurried. */
  LOOP_POLL_INTERVAL_SECONDS: z.coerce.number().int().min(30).max(3600).default(60),
  /** How long to wait for CI on a pull request before giving up, in minutes. */
  LOOP_CI_TIMEOUT_MINUTES: z.coerce.number().int().min(1).max(180).default(30),
  /** Wall-clock ceiling for one Claude invocation, in minutes. */
  LOOP_AGENT_TIMEOUT_MINUTES: z.coerce.number().int().min(1).max(180).default(45),
  /** Model alias passed to Claude Code. Empty means the CLI's own default. */
  LOOP_AGENT_MODEL: z.string().default(''),
  /**
   * Model alias for the second reviewer at high risk.
   *
   * Optional. Two fresh sessions are independent enough; a different model is
   * extra diversity, not a requirement.
   */
  LOOP_REVIEWER_B_MODEL: z.string().default(''),

  // --- Runaway protection -------------------------------------------------
  // Unattended does not mean unlimited accidental spend. These bound the loop
  // as a whole, where the retry limits above bound a single issue.
  /** Claude invocations started in any rolling hour. `0` disables the check. */
  LOOP_MAX_MODEL_INVOCATIONS_PER_HOUR: z.coerce.number().int().min(0).max(1000).default(60),
  /** Issues claimed in any rolling 24 hours. `0` disables the check. */
  LOOP_MAX_ISSUES_PER_DAY: z.coerce.number().int().min(0).max(1000).default(20),
  /** Wall-clock ceiling on one unattended session, in hours. `0` disables. */
  LOOP_MAX_RUNTIME_HOURS: z.coerce.number().int().min(0).max(168).default(12),

  // --- Recovery -----------------------------------------------------------
  /** Consecutive GitHub or Claude failures tolerated before stopping. */
  LOOP_MAX_CONSECUTIVE_FAILURES: z.coerce.number().int().min(1).max(50).default(8),
  /** First backoff delay, in seconds. Doubles per failure, with a ceiling. */
  LOOP_BACKOFF_BASE_SECONDS: z.coerce.number().int().min(1).max(600).default(30),
  LOOP_BACKOFF_MAX_SECONDS: z.coerce.number().int().min(60).max(7200).default(900),
})

export type RunnerConfig = z.infer<typeof runnerConfigSchema>

export function loadConfig(source: Record<string, string | undefined> = process.env): RunnerConfig {
  return runnerConfigSchema.parse(source)
}

/**
 * Issues this run may take, resolved from mode and the explicit override.
 *
 * `0` means unlimited. Attended runs default to one; unattended runs default to
 * unlimited, because a limit that stops an unattended loop after one issue
 * would make the mode pointless.
 */
export function issueBudget(config: RunnerConfig): number {
  if (config.LOOP_MAX_ISSUES !== undefined) return config.LOOP_MAX_ISSUES
  return config.LOOP_UNATTENDED ? 0 : 1
}

/**
 * Dependencies, installed into a fresh worktree before anything runs.
 *
 * `git worktree add` produces a checkout with no `node_modules`, so without
 * this every verification step fails on the first run for a reason that has
 * nothing to do with the change. `--frozen-lockfile` because a coding agent
 * must not silently resolve a different dependency tree than CI will.
 */
export const INSTALL_STEP = {
  name: 'install',
  command: 'bun',
  args: ['install', '--frozen-lockfile'],
} as const

/**
 * Fallback verification, used only when the policy defines no tiers.
 *
 * The real list is `tiers` in `.github/loop-policy.json`, resolved per risk
 * level by `stepsForRisk`. This exists so the runner still does something
 * sensible against a policy file written before tiers existed.
 */
export const VERIFICATION_STEPS = [
  { name: 'lint', command: 'bun', args: ['run', 'lint'], timeoutMinutes: 10 },
  { name: 'typecheck', command: 'bun', args: ['run', 'typecheck'], timeoutMinutes: 10 },
  { name: 'test', command: 'bun', args: ['run', 'test'], timeoutMinutes: 20 },
  { name: 'build', command: 'bun', args: ['run', 'build'], timeoutMinutes: 20 },
] as const

export type VerificationStep = (typeof VERIFICATION_STEPS)[number]
