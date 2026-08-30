import type { Candidate } from './eligibility.ts'
import type { GateOutcome } from './merge-gate.ts'
import type { ReviewResult } from './review.ts'
import { sanitiseForMarkdown } from './review.ts'
import type { RiskAssessment } from './risk.ts'
import type { LoopState } from './state.ts'

const DECISION_LABEL: Record<GateOutcome['decision'], string> = {
  auto_merge: 'Auto merge enabled',
  human_approval_required: 'Human approval required',
  changes_requested: 'Changes requested',
  blocked: 'Blocked — automation stopped',
  waiting: 'Waiting',
}

export interface PullRequestView {
  issue: number | null
  risk: RiskAssessment
  review: ReviewResult
  outcome: GateOutcome
  state: LoopState
  maxReviewAttempts: number
  /** Names and conclusions of the required checks, for the status table. */
  checks: ReadonlyArray<{ name: string; conclusion: string }>
}

function table(rows: ReadonlyArray<[string, string]>): string {
  return ['| | |', '| --- | --- |', ...rows.map(([key, value]) => `| ${key} | ${value} |`)].join(
    '\n',
  )
}

/**
 * The human-readable half of the sticky comment.
 *
 * Everything a person needs to answer "what is the loop doing and why did it
 * stop?" without opening a workflow log. All model-derived text is escaped:
 * it is ultimately derived from pull request content, which is untrusted.
 */
export function renderPullRequestSummary(view: PullRequestView): string {
  const { outcome, risk, review, state } = view

  const findings = review.findings
    .map(
      (finding) =>
        `| ${finding.severity} | ${finding.file ?? '—'} | ${sanitiseForMarkdown(finding.description)} | ${sanitiseForMarkdown(finding.suggested_action)} |`,
    )
    .join('\n')

  const sections = [
    `### Autonomous loop — ${DECISION_LABEL[outcome.decision]}`,
    '',
    table([
      ['Issue', view.issue === null ? '—' : `#${view.issue}`],
      ['Risk', `\`${risk.risk}\``],
      ['Review', `\`${review.status}\``],
      ['Review attempts', `${state.reviewAttempts} of ${view.maxReviewAttempts}`],
      ['Risk gate', outcome.riskGate],
      ['Review gate', outcome.reviewGate],
      ['Decision', DECISION_LABEL[outcome.decision]],
    ]),
    '',
    '**Why**',
    '',
    ...outcome.reasons.map((reason) => `- ${sanitiseForMarkdown(reason)}`),
    '',
    '**Risk classification**',
    '',
    ...risk.reasons.map(
      (reason) =>
        `- \`${reason.risk}\` from ${reason.source}: ${sanitiseForMarkdown(reason.detail)}`,
    ),
    '',
    '**Required checks**',
    '',
    ...view.checks.map((check) => `- ${check.name}: ${check.conclusion}`),
  ]

  if (review.findings.length > 0) {
    sections.push(
      '',
      `**Findings (${review.findings.length})**`,
      '',
      '| Severity | File | Description | Suggested action |',
      '| --- | --- | --- | --- |',
      findings,
    )
  }

  sections.push('', '**Review summary**', '', `> ${sanitiseForMarkdown(review.summary)}`)

  return sections.join('\n')
}

/** The job summary for a next-issue selection run. */
export function renderSelectionSummary(
  candidates: readonly Candidate[],
  selected: number | null,
  stopReason: string | null,
): string {
  const rows = candidates.map((candidate) => {
    const dependencies =
      candidate.dependencies.length === 0
        ? '—'
        : candidate.dependencies
            .map((d) => `#${d.number}${d.satisfied ? ' ok' : ' open'}`)
            .join(', ')
    const status = candidate.eligible ? 'eligible' : candidate.reasons.join('; ')
    return `| #${candidate.issue.number} | ${sanitiseForMarkdown(candidate.issue.title)} | ${dependencies} | ${sanitiseForMarkdown(status)} |`
  })

  return [
    '### Next issue selection',
    '',
    selected === null
      ? `**No issue selected.** ${sanitiseForMarkdown(stopReason ?? 'unknown reason')}`
      : `**Selected #${selected}.**`,
    '',
    '| Issue | Title | Dependencies | Status |',
    '| --- | --- | --- | --- |',
    ...rows,
  ].join('\n')
}
