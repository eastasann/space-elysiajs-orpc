import { z } from 'zod'

/**
 * Runner configuration.
 *
 * Conservative by default: one issue, bounded retries, no watch mode. Running
 * unattended for longer is something a developer opts into deliberately, not
 * something that happens because they forgot to set a limit.
 */
export const runnerConfigSchema = z.object({
  /**
   * Issues to take in a single `loop:once`/`loop:watch` run.
   *
   * `0` means unlimited and must be set on purpose. The default of 1 is the
   * whole safety story for a first run: it cannot walk the backlog while
   * nobody is watching.
   */
  LOOP_MAX_ISSUES: z.coerce.number().int().min(0).max(100).default(1),
  /** Implementation attempts before an issue is marked blocked. */
  LOCAL_AGENT_MAX_FIX_ROUNDS: z.coerce.number().int().min(1).max(10).default(3),
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
})

export type RunnerConfig = z.infer<typeof runnerConfigSchema>

export function loadConfig(source: Record<string, string | undefined> = process.env): RunnerConfig {
  return runnerConfigSchema.parse(source)
}

/** Verification commands the runner runs itself, in order, before opening a PR. */
export const VERIFICATION_STEPS = [
  { name: 'lint', command: 'bun', args: ['run', 'lint'] },
  { name: 'typecheck', command: 'bun', args: ['run', 'typecheck'] },
  { name: 'test', command: 'bun', args: ['run', 'test'] },
  { name: 'build', command: 'bun', args: ['run', 'build'] },
] as const

export type VerificationStep = (typeof VERIFICATION_STEPS)[number]
