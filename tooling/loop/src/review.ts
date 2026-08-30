import { z } from 'zod'
import { isAtLeastSeverity, type Severity, SeveritySchema } from './policy.ts'

/**
 * Machine-readable review result.
 *
 * The review agent's prose never decides anything on its own: it must emit this
 * shape, the shape is validated before use, and the merge gate reads only the
 * validated fields. Anything that fails validation is treated as `blocked`
 * rather than as approval.
 */
export const FindingSchema = z.object({
  severity: SeveritySchema,
  /** Repository-relative path, when the finding is about one file. */
  file: z.string().max(512).nullish(),
  line: z.number().int().min(1).nullish(),
  description: z.string().min(1).max(2000),
  suggested_action: z.string().min(1).max(2000),
  /** Which check produced this. `agent` marks model-authored findings. */
  source: z.string().max(64).default('agent'),
  category: z.string().max(64).default('review'),
})
export type Finding = z.infer<typeof FindingSchema>

export const ReviewStatusSchema = z.enum(['approve', 'request_changes', 'blocked'])
export type ReviewStatus = z.infer<typeof ReviewStatusSchema>

export const ReviewResultSchema = z.object({
  status: ReviewStatusSchema,
  findings: z.array(FindingSchema).max(200),
  summary: z.string().min(1).max(8000),
})
export type ReviewResult = z.infer<typeof ReviewResultSchema>

export type ParseOutcome =
  | { ok: true; result: ReviewResult }
  | { ok: false; errors: string[]; result: ReviewResult }

/** Control characters that would corrupt a job summary or a pull request comment. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: removing them is the point
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g

function sanitiseText(value: string): string {
  return value.replace(CONTROL_CHARACTERS, '')
}

/**
 * Neutralise text before it is embedded in Markdown this loop publishes.
 *
 * Review output is derived from pull request and issue content, which is
 * untrusted. Escaping backticks and HTML comment markers stops a crafted diff
 * from breaking out of a code fence and forging the rest of a status comment —
 * the comment the loop itself reads back as state.
 */
export function sanitiseForMarkdown(value: string): string {
  return sanitiseText(value)
    .replaceAll('`', "'")
    .replaceAll('<!--', '<!––')
    .replaceAll('-->', '––>')
}

function blockedResult(summary: string, errors: readonly string[]): ReviewResult {
  return {
    status: 'blocked',
    summary,
    findings: errors.map((error) => ({
      severity: 'high' as const,
      file: null,
      line: null,
      description: `Review agent output was not usable: ${error}`,
      suggested_action:
        'Re-run the review agent. If it keeps emitting an invalid result the loop is blocked and needs a human.',
      source: 'review-validation',
      category: 'automation',
    })),
  }
}

/**
 * Validate a review agent's raw output.
 *
 * On failure the caller still receives a usable `ReviewResult` — a blocked one.
 * That matters: a review step that crashes must not leave the gate with no
 * opinion, because "no opinion" is easy to mistake for "no objection".
 */
export function parseReviewResult(raw: unknown): ParseOutcome {
  const parsed = ReviewResultSchema.safeParse(raw)
  if (!parsed.success) {
    const errors = parsed.error.issues.map(
      (issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`,
    )
    return { ok: false, errors, result: blockedResult('Review result failed validation.', errors) }
  }

  return {
    ok: true,
    result: {
      status: parsed.data.status,
      summary: sanitiseText(parsed.data.summary),
      findings: parsed.data.findings.map((finding) => ({
        ...finding,
        description: sanitiseText(finding.description),
        suggested_action: sanitiseText(finding.suggested_action),
      })),
    },
  }
}

const FENCED_JSON = /```(?:json)?\s*\n([\s\S]*?)\n```/

/**
 * Extract and validate a review result from an agent's raw text output.
 *
 * Models wrap JSON in prose and code fences; both are tolerated. What is not
 * tolerated is prose *instead of* JSON — that is a blocked review, not an
 * approval.
 */
export function parseReviewText(text: string): ParseOutcome {
  const candidate = FENCED_JSON.exec(text)?.[1] ?? text

  let raw: unknown
  try {
    raw = JSON.parse(candidate)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unparseable'
    const reason = `output was not JSON (${message})`
    return {
      ok: false,
      errors: [reason],
      result: blockedResult('Review agent did not return JSON.', [reason]),
    }
  }

  return parseReviewResult(raw)
}

/** Findings at or above the policy's blocking severity. */
export function blockingFindings(
  findings: readonly Finding[],
  blockingSeverity: Severity,
): Finding[] {
  return findings.filter((finding) => isAtLeastSeverity(finding.severity, blockingSeverity))
}

/**
 * Combine deterministic check findings with the agent's review.
 *
 * Deterministic findings can only make the outcome stricter. An agent that
 * approves cannot clear a secret this repository's own scanner found, and an
 * agent that is unavailable cannot make the checks disappear.
 */
export function mergeReview(
  agent: ReviewResult,
  deterministic: readonly Finding[],
  blockingSeverity: Severity,
): ReviewResult {
  const findings = [...deterministic, ...agent.findings]
  const blocking = blockingFindings(findings, blockingSeverity)

  const status: ReviewStatus =
    agent.status === 'blocked'
      ? 'blocked'
      : blocking.length > 0 || agent.status === 'request_changes'
        ? 'request_changes'
        : 'approve'

  return { status, findings, summary: agent.summary }
}
