import type { RunnerConfig } from './config.ts'

/**
 * Runaway protection for a loop nobody is watching.
 *
 * The per-issue retry limits bound how much effort one issue can absorb. These
 * bound the loop as a whole: a bug that makes every issue fail instantly would
 * respect every retry limit and still burn a day of model usage in an hour.
 *
 * Counting is by event, in memory, over rolling windows. Deliberately not by
 * token or by dollar: Claude Code reports a cost per invocation, but building a
 * spend limit on a number whose contract is not guaranteed would fail in the
 * direction of not stopping. Counting invocations is crude and correct.
 */

export type BudgetKind = 'invocations' | 'issues' | 'runtime'

export interface BudgetExceeded {
  kind: BudgetKind
  detail: string
}

export class Budget {
  private readonly invocations: number[] = []
  private readonly issues: number[] = []
  private readonly startedAt: number

  constructor(
    private readonly config: RunnerConfig,
    private readonly now: () => number = Date.now,
  ) {
    this.startedAt = now()
  }

  /** Record one Claude invocation. Called for coding and review passes alike. */
  recordInvocation(): void {
    this.invocations.push(this.now())
  }

  /** Record one issue claimed. */
  recordIssue(): void {
    this.issues.push(this.now())
  }

  private within(timestamps: readonly number[], windowMs: number): number {
    const cutoff = this.now() - windowMs
    return timestamps.filter((at) => at >= cutoff).length
  }

  /** Drop entries that have aged out, so a long session does not grow forever. */
  private prune(): void {
    const day = this.now() - 24 * 60 * 60 * 1000
    const hour = this.now() - 60 * 60 * 1000

    while (this.invocations.length > 0 && (this.invocations[0] as number) < hour) {
      this.invocations.shift()
    }
    while (this.issues.length > 0 && (this.issues[0] as number) < day) this.issues.shift()
  }

  /**
   * Whether anything stops the loop taking more work.
   *
   * Checked before claiming an issue, never mid-issue: stopping halfway through
   * would leave a claimed issue and a half-built branch, which costs more to
   * clean up than the invocation it saved.
   */
  check(): BudgetExceeded | null {
    this.prune()

    const perHour = this.config.LOOP_MAX_MODEL_INVOCATIONS_PER_HOUR
    if (perHour > 0) {
      const used = this.within(this.invocations, 60 * 60 * 1000)
      if (used >= perHour) {
        return {
          kind: 'invocations',
          detail: `${used} model invocations in the last hour, at the limit of ${perHour}. Raise LOOP_MAX_MODEL_INVOCATIONS_PER_HOUR to continue.`,
        }
      }
    }

    const perDay = this.config.LOOP_MAX_ISSUES_PER_DAY
    if (perDay > 0) {
      const used = this.within(this.issues, 24 * 60 * 60 * 1000)
      if (used >= perDay) {
        return {
          kind: 'issues',
          detail: `${used} issues claimed in the last 24 hours, at the limit of ${perDay}. Raise LOOP_MAX_ISSUES_PER_DAY to continue.`,
        }
      }
    }

    const maxHours = this.config.LOOP_MAX_RUNTIME_HOURS
    if (maxHours > 0) {
      const elapsed = this.now() - this.startedAt
      if (elapsed >= maxHours * 60 * 60 * 1000) {
        return {
          kind: 'runtime',
          detail: `this session has run for ${Math.round(elapsed / 3_600_000)} hours, at the limit of ${maxHours}. Restart it, or raise LOOP_MAX_RUNTIME_HOURS.`,
        }
      }
    }

    return null
  }

  /** What has been spent so far, for the run summary. */
  snapshot(): { invocations: number; issues: number; runtimeMs: number } {
    this.prune()
    return {
      invocations: this.invocations.length,
      issues: this.issues.length,
      runtimeMs: this.now() - this.startedAt,
    }
  }
}
