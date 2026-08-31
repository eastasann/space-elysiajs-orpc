/**
 * Evaluate one pull request and decide what the loop should do with it.
 *
 * Reads:
 *   LOOP_CONTEXT       path to the evaluation context JSON
 *   LOOP_DIFF          path to the unified diff of the pull request
 *   LOOP_REVIEW_OUTPUT colon-separated paths to each review agent's raw output
 *                      (optional; one per independent pass the tier requires)
 *   LOOP_PROPOSED_POLICY path to the policy file as the pull request proposes it,
 *                      when it changes one (optional)
 *   LOOP_POLICY        path to the policy file (defaults to .github/loop-policy.json)
 *   LOOP_OUTPUT_DIR    directory to write result.json and summary.md into
 *
 * Writes the decision as JSON and Markdown, and appends the fields the workflow
 * branches on to $GITHUB_OUTPUT. It performs no GitHub calls of its own: acting
 * on a decision is the workflow's job, which keeps this testable and keeps the
 * token out of the evaluation.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { runDeterministicChecks } from '../src/checks/index.ts'
import { findUnsafeWorkflowChanges, findWeakenedProtections } from '../src/control-plane.ts'
import { parseUnifiedDiff } from '../src/diff.ts'
import { decideMerge, HUMAN_HOLD_LABEL } from '../src/merge-gate.ts'
import { parsePolicy, reviewersForRisk } from '../src/policy.ts'
import { detectRecurrence, toFindingRecord } from '../src/recurrence.ts'
import { blockingFindings, mergeReview, parseReviewText, type ReviewResult } from '../src/review.ts'
import { classifyRiskMonotonic } from '../src/risk.ts'
import { parseLoopState, recordRound, serialiseLoopState } from '../src/state.ts'
import { renderPullRequestSummary } from '../src/summary.ts'
import { closingIssue, EvaluationContextSchema } from './context.ts'

function required(name: string): string {
  const value = process.env[name]
  if (value === undefined || value.trim() === '') {
    process.stderr.write(`${name} is required\n`)
    process.exit(1)
  }
  return value
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'))
}

/**
 * The review result to use when no agent produced one.
 *
 * `blocked`, never `approve`: an unconfigured or crashed review agent must stop
 * the loop and ask for a human, not wave the change through.
 */
function unavailableReview(reason: string): ReviewResult {
  return {
    status: 'blocked',
    summary: `No usable review agent result: ${reason}`,
    findings: [
      {
        severity: 'high',
        file: null,
        line: null,
        description: `The review agent produced no result (${reason}).`,
        suggested_action:
          'Configure a review agent provider (see docs/loop-engineering.md), or review and merge this pull request by hand.',
        source: 'review-availability',
        category: 'automation',
      },
    ],
  }
}

const policyPath = process.env.LOOP_POLICY ?? '.github/loop-policy.json'
const policy = parsePolicy(readJson(policyPath))

const context = EvaluationContextSchema.parse(readJson(required('LOOP_CONTEXT')))
const diff = parseUnifiedDiff(readFileSync(required('LOOP_DIFF'), 'utf8'))

/**
 * Review output paths, one per independent pass.
 *
 * `LOOP_REVIEW_OUTPUT` holds a colon-separated list so a high-risk tier can
 * supply two. A path that is configured but absent produces an unavailable
 * review rather than being dropped: a reviewer that failed to run must reduce
 * the count the aggregate sees, or "we could not review it" would silently
 * become "it needs no review".
 */
const reviewOutputPaths = (process.env.LOOP_REVIEW_OUTPUT ?? '')
  .split(':')
  .map((path) => path.trim())
  .filter((path) => path !== '')

const deterministic = runDeterministicChecks(diff)

const agentReviews: ReviewResult[] =
  reviewOutputPaths.length === 0
    ? [unavailableReview('no review agent is configured')]
    : reviewOutputPaths.map((path) =>
        existsSync(path)
          ? parseReviewText(readFileSync(path, 'utf8')).result
          : unavailableReview('the review agent wrote no output'),
      )

// Deterministic findings ride on the first review so they can only ever make
// the aggregate stricter, never supply a missing opinion.
const reviews = agentReviews.map((review, index) =>
  index === 0 ? mergeReview(review, deterministic, policy.review.blockingSeverity) : review,
)

const labels = [...context.pullRequest.labels, ...context.issueLabels]

// The head policy is read from the checkout the workflow is running against,
// which is the default branch — so `policy` is already the trusted one. When a
// pull request proposes a different policy the workflow passes it separately;
// the stricter of the two governs.
const proposedPolicyPath = process.env.LOOP_PROPOSED_POLICY
const proposedPolicy =
  proposedPolicyPath !== undefined && proposedPolicyPath !== '' && existsSync(proposedPolicyPath)
    ? parsePolicy(readJson(proposedPolicyPath))
    : undefined

const risk = classifyRiskMonotonic({
  diff,
  labels,
  basePolicy: policy,
  headPolicy: proposedPolicy,
})

const weakenedProtections =
  proposedPolicy === undefined
    ? findUnsafeWorkflowChanges(diff)
    : [
        ...findWeakenedProtections({ base: policy, head: proposedPolicy, diff }),
        ...findUnsafeWorkflowChanges(diff),
      ]

const issue = closingIssue(context.pullRequest.body)
const previous = parseLoopState(context.stickyComment, issue)

const outcome = decideMerge({
  risk: risk.risk,
  reviews,
  requiredReviewers: reviewersForRisk(policy, risk.risk),
  checks: context.checks,
  requiredChecks: context.requiredChecks,
  reviewAttempts: previous.reviewAttempts,
  maxReviewAttempts: policy.retry.maxReviewAttempts,
  humanApprovals: context.humanApprovals,
  isFork: context.pullRequest.isFork,
  isDraft: context.pullRequest.isDraft,
  blockingSeverity: policy.review.blockingSeverity,
  weakenedProtections,
  humanHold: labels.includes(HUMAN_HOLD_LABEL),
})

const review = outcome.review

// Findings only mean anything for recurrence once compared against a *prior*
// attempt's, so this reads `previous.history` before the current round is
// appended to it below.
const recurrence = detectRecurrence(review.findings, previous.history, context.pullRequest.headSha)

// Retaining findings from a round that did not ask for changes would remember
// things no fix round will ever need to have recalled — `waiting` and
// `auto_merge` rounds keep nothing.
const retainedFindings =
  outcome.decision === 'changes_requested'
    ? blockingFindings(review.findings, policy.review.blockingSeverity).map(toFindingRecord)
    : []

const state = recordRound({
  state: { ...previous, issue },
  headSha: context.pullRequest.headSha,
  reviewStatus: review.status,
  decision: outcome.decision,
  at: new Date().toISOString(),
  findings: retainedFindings,
})

const summary = renderPullRequestSummary({
  issue,
  risk,
  review,
  outcome,
  state,
  maxReviewAttempts: policy.retry.maxReviewAttempts,
  checks: context.requiredChecks.map((name) => ({
    name,
    conclusion: context.checks.find((check) => check.name === name)?.conclusion ?? 'missing',
  })),
  recurrence,
})

const outputDir = process.env.LOOP_OUTPUT_DIR ?? '.loop'
mkdirSync(outputDir, { recursive: true })

writeFileSync(
  join(outputDir, 'result.json'),
  `${JSON.stringify({ risk, review, outcome, state, issue, recurrence }, null, 2)}\n`,
)
writeFileSync(join(outputDir, 'summary.md'), `${summary}\n\n${serialiseLoopState(state)}\n`)

const githubOutput = process.env.GITHUB_OUTPUT
if (githubOutput !== undefined) {
  appendFileSync(
    githubOutput,
    [
      `decision=${outcome.decision}`,
      `risk=${risk.risk}`,
      `review_status=${review.status}`,
      `risk_gate=${outcome.riskGate}`,
      `review_gate=${outcome.reviewGate}`,
      `should_dispatch_fix=${outcome.shouldDispatchFix}`,
      `review_attempts=${state.reviewAttempts}`,
      `issue=${issue ?? ''}`,
      '',
    ].join('\n'),
  )
}

process.stdout.write(`${outcome.decision} (risk=${risk.risk}, review=${review.status})\n`)
