import type { Severity } from './policy.ts'
import { blockingFindings, type Finding, type ReviewResult, type ReviewStatus } from './review.ts'

/**
 * Combining several independent reviews into one verdict.
 *
 * High-risk changes are reviewed twice, by two Claude Code invocations that
 * share no session and no context. Two reviewers only add safety if
 * disagreement is resolved in the strict direction, so every rule here fails
 * closed: the aggregate is as pessimistic as the most pessimistic reviewer, and
 * a review that is missing or unusable is never counted as an approval.
 */

export interface AggregateInput {
  /** One entry per review pass that produced a usable result. */
  reviews: readonly ReviewResult[]
  /** Independent passes the risk tier demands. */
  required: number
  blockingSeverity: Severity
}

export interface AggregateOutcome {
  status: ReviewStatus
  findings: Finding[]
  summary: string
  /** Usable reviews received, against the number required. */
  received: number
  required: number
  /** True when every reviewer reached the same status. */
  unanimous: boolean
  reasons: string[]
}

/**
 * Reduce N independent reviews to one status.
 *
 * The rules, in order:
 *
 * 1. Fewer usable reviews than the tier requires → `blocked`. A reviewer that
 *    could not be run has expressed no opinion, and "no opinion" must never be
 *    read as "no objection".
 * 2. Any reviewer `blocked` → `blocked`.
 * 3. Any reviewer `request_changes`, or any finding at or above the blocking
 *    severity from *any* reviewer → `request_changes`.
 * 4. Otherwise → `approve`.
 *
 * Rule 3 is the reading the specification asks for: two reviewers merge when
 * both approve, and informational findings attached to an approval do not hold
 * the pull request. A reviewer that returns `request_changes` sends it to the
 * fix loop no matter what the other one said.
 */
export function aggregateReviews(input: AggregateInput): AggregateOutcome {
  const reasons: string[] = []
  const findings = dedupe(input.reviews.flatMap((review) => review.findings))
  const summary = input.reviews
    .map((review, index) => `Reviewer ${letter(index)}: ${review.summary}`)
    .join('\n\n')

  const received = input.reviews.length
  const statuses = input.reviews.map((review) => review.status)
  const unanimous = received > 0 && statuses.every((status) => status === statuses[0])

  const base = {
    findings,
    received,
    required: input.required,
    unanimous,
  }

  if (received < input.required) {
    reasons.push(
      `only ${received} of ${input.required} required independent review(s) produced a usable result`,
    )
    return {
      ...base,
      status: 'blocked',
      summary:
        summary === ''
          ? 'No reviewer produced a usable result.'
          : `${summary}\n\nNot enough independent reviews to decide.`,
      reasons,
    }
  }

  const blockedBy = statuses.filter((status) => status === 'blocked').length
  if (blockedBy > 0) {
    reasons.push(`${blockedBy} reviewer(s) reported \`blocked\``)
    return { ...base, status: 'blocked', summary, reasons }
  }

  const blocking = blockingFindings(findings, input.blockingSeverity)
  const changesRequested = statuses.filter((status) => status === 'request_changes').length

  if (changesRequested > 0) {
    reasons.push(`${changesRequested} of ${received} reviewer(s) requested changes`)
  }
  if (blocking.length > 0) {
    reasons.push(`${blocking.length} finding(s) at or above \`${input.blockingSeverity}\` severity`)
  }

  if (changesRequested > 0 || blocking.length > 0) {
    return { ...base, status: 'request_changes', summary, reasons }
  }

  reasons.push(
    received === 1
      ? 'the reviewer approved with no blocking findings'
      : `all ${received} independent reviewers approved with no blocking findings`,
  )
  return { ...base, status: 'approve', summary, reasons }
}

/** `A`, `B`, `C`… so a summary names which reviewer said what. */
function letter(index: number): string {
  return String.fromCharCode(65 + (index % 26))
}

/**
 * Collapse findings two reviewers both raised.
 *
 * Independent reviewers frequently notice the same thing. Reporting it twice
 * makes the pull request comment look like twice the problem, and inflates any
 * count taken over the list. Severity is kept at the highest of the duplicates.
 */
function dedupe(findings: readonly Finding[]): Finding[] {
  const order: Record<Severity, number> = { info: 0, low: 1, medium: 2, high: 3, critical: 4 }
  const byKey = new Map<string, Finding>()

  for (const finding of findings) {
    const key = `${finding.file ?? ''}:${finding.line ?? ''}:${finding.description.toLowerCase()}`
    const existing = byKey.get(key)
    if (existing === undefined || order[finding.severity] > order[existing.severity]) {
      byKey.set(key, finding)
    }
  }

  return [...byKey.values()]
}
