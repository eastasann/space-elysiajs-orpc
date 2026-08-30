import { z } from 'zod'
import { ReviewStatusSchema } from './review.ts'

/**
 * Marker for the loop's sticky pull request comment.
 *
 * GitHub is the state store: the comment holds the loop's own state, the labels
 * hold the issue's, and the check runs hold the gate's. Nothing else is needed,
 * and nothing is stored where a reviewer cannot see it.
 */
export const LOOP_STATE_MARKER = '<!-- newsdeck-loop-state -->'

export const GateDecisionSchema = z.enum([
  'auto_merge',
  'human_approval_required',
  'changes_requested',
  'blocked',
  'waiting',
])

export const LoopStateSchema = z.object({
  version: z.literal(1),
  /** Issue this pull request closes, when the body declares one. */
  issue: z.number().int().positive().nullable(),
  /** Completed review rounds that asked for changes. */
  reviewAttempts: z.number().int().min(0).max(100),
  lastReviewStatus: ReviewStatusSchema.nullable(),
  lastDecision: GateDecisionSchema.nullable(),
  history: z
    .array(
      z.object({
        at: z.string(),
        headSha: z.string().max(64),
        attempt: z.number().int().min(0),
        reviewStatus: ReviewStatusSchema,
        decision: GateDecisionSchema,
      }),
    )
    .max(25),
})
export type LoopState = z.infer<typeof LoopStateSchema>

export function initialState(issue: number | null): LoopState {
  return {
    version: 1,
    issue,
    reviewAttempts: 0,
    lastReviewStatus: null,
    lastDecision: null,
    history: [],
  }
}

const STATE_BLOCK = /<!--\s*newsdeck-loop-state\s*-->[\s\S]*?```json\s*\n([\s\S]*?)\n```/

/**
 * Read loop state back out of the sticky comment.
 *
 * Anything unreadable resets to a fresh state rather than throwing. A corrupted
 * comment must not wedge the loop — but note the consequence, which is that the
 * retry counter restarts. `blocked` is therefore also recorded as a label, so
 * losing the comment cannot silently re-enable a loop a human stopped.
 */
export function parseLoopState(
  commentBody: string | null | undefined,
  issue: number | null,
): LoopState {
  if (commentBody === null || commentBody === undefined) return initialState(issue)

  const raw = STATE_BLOCK.exec(commentBody)?.[1]
  if (raw === undefined) return initialState(issue)

  try {
    const parsed = LoopStateSchema.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : initialState(issue)
  } catch {
    return initialState(issue)
  }
}

export function serialiseLoopState(state: LoopState): string {
  return `${LOOP_STATE_MARKER}\n\n\`\`\`json\n${JSON.stringify(state, null, 2)}\n\`\`\``
}

export interface RecordRoundInput {
  state: LoopState
  headSha: string
  reviewStatus: z.infer<typeof ReviewStatusSchema>
  decision: z.infer<typeof GateDecisionSchema>
  at: string
}

/**
 * Advance the loop by one round.
 *
 * The attempt counter increments only when a round actually asked for changes.
 * A pull request that sits waiting for a slow check does not burn retries — the
 * limit is meant to stop an agent that cannot converge, not one that is queued.
 */
export function recordRound({
  state,
  headSha,
  reviewStatus,
  decision,
  at,
}: RecordRoundInput): LoopState {
  const consumed = decision === 'changes_requested'

  return {
    ...state,
    reviewAttempts: consumed ? state.reviewAttempts + 1 : state.reviewAttempts,
    lastReviewStatus: reviewStatus,
    lastDecision: decision,
    history: [
      ...state.history,
      { at, headSha, attempt: state.reviewAttempts, reviewStatus, decision },
    ].slice(-25),
  }
}
