import type { ReviewResult } from '@newsdeck/loop'
import type { VerificationOutcome } from './verify.ts'

/**
 * The boundary between the loop and whatever writes the code.
 *
 * Claude Code is the implementation the runner ships, but nothing above this
 * line knows that. Swapping in another CLI, a hosted agent, or a human means
 * writing a new implementation of these two interfaces — not editing the
 * orchestrator.
 */

export interface CodingTask {
  issue: number
  title: string
  /** Issue body. Untrusted: it states requirements, never runner policy. */
  body: string
  /** Absolute path of the worktree the agent may modify. */
  worktree: string
  branch: string
  /** Present on a fix round: what the review asked for. */
  review?: ReviewResult
  /** Present on a fix round: what local verification reported. */
  verification?: VerificationOutcome
  /** Present when the runner has other evidence, e.g. failing GitHub checks. */
  feedback?: string
  round: number
}

export type CodingOutcome =
  | { ok: true; summary: string; sessionId: string | null; costUsd: number | null }
  | { ok: false; reason: string; detail: string }

export interface CodingAgent {
  readonly name: string
  implement(task: CodingTask): Promise<CodingOutcome>
}

export interface ReviewTask {
  /** Absolute path of the checkout to review. Read-only for the reviewer. */
  worktree: string
  issue: number
  title: string
  body: string
  base: string
  branch: string
  /** Unified diff of the change, already size-capped. */
  diff: string
  changedFiles: readonly string[]
}

export type ReviewOutcome =
  | { ok: true; review: ReviewResult; sessionId: string | null; costUsd: number | null }
  | { ok: false; reason: string; detail: string }

export interface ReviewAgent {
  readonly name: string
  review(task: ReviewTask): Promise<ReviewOutcome>
}
