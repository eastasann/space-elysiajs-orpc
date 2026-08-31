import type { RunnerConfig } from './config.ts'

/**
 * Recovery from failures that are somebody else's problem.
 *
 * GitHub goes down, a network drops, a model call times out. A long-running
 * runner that dies on the first of those is not long-running. It also must not
 * hammer a service that is already struggling, so delays grow exponentially and
 * a run of consecutive failures eventually gives up rather than looping forever.
 *
 * Only *transient* failures come here. A failing test is not a transient
 * failure — it is the answer — and treating it as one would retry a real defect
 * until the budget ran out.
 */

export class Backoff {
  private consecutive = 0

  constructor(private readonly config: RunnerConfig) {}

  /** A step succeeded. The next failure starts from the base delay again. */
  succeeded(): void {
    this.consecutive = 0
  }

  /**
   * A step failed transiently.
   *
   * Returns how long to wait, or `null` when the failures have gone on long
   * enough that something is genuinely wrong and the loop should stop.
   */
  failed(): { waitMs: number; consecutive: number } | null {
    this.consecutive += 1

    if (this.consecutive > this.config.LOOP_MAX_CONSECUTIVE_FAILURES) return null

    const base = this.config.LOOP_BACKOFF_BASE_SECONDS * 1000
    const ceiling = this.config.LOOP_BACKOFF_MAX_SECONDS * 1000
    const exponential = base * 2 ** (this.consecutive - 1)

    return { waitMs: Math.min(exponential, ceiling), consecutive: this.consecutive }
  }

  get failures(): number {
    return this.consecutive
  }
}

/**
 * Whether a failure is worth waiting out.
 *
 * Errs toward `false`. Retrying something that is not transient wastes the
 * budget and hides a real problem; declining to retry something that was
 * transient costs one cycle of the poll interval, which is cheap.
 */
const TRANSIENT_PATTERNS = [
  /\bETIMEDOUT\b/i,
  /\bECONNRESET\b/i,
  /\bECONNREFUSED\b/i,
  /\bENOTFOUND\b/i,
  /\bEAI_AGAIN\b/i,
  /socket hang up/i,
  /network is unreachable/i,
  /\b5\d\d\b.*\b(?:server error|bad gateway|service unavailable|gateway timeout)\b/i,
  /\b(?:502|503|504)\b/,
  /rate limit/i,
  /secondary rate limit/i,
  /\bAPI rate limit exceeded\b/i,
  /temporarily unavailable/i,
  /timed out/i,
]

export function isTransient(message: string): boolean {
  return TRANSIENT_PATTERNS.some((pattern) => pattern.test(message))
}

/**
 * Whether a failure means the credential is gone rather than the service.
 *
 * Distinguished from transient because the response is different: authentication
 * loss stops the loop claiming new work and retries slowly, while a 503 is worth
 * an immediate short backoff.
 */
const AUTH_PATTERNS = [
  /\b401\b/,
  /\b403\b/,
  /bad credentials/i,
  /not authenticated/i,
  /authentication (?:failed|rejected|required)/i,
  /requires? (?:a )?login/i,
  /token (?:is )?(?:invalid|expired|revoked)/i,
]

export function isAuthFailure(message: string): boolean {
  return AUTH_PATTERNS.some((pattern) => pattern.test(message))
}
