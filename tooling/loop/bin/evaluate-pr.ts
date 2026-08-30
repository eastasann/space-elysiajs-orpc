/**
 * Evaluate one pull request and decide what the loop should do with it.
 *
 * Reads:
 *   LOOP_CONTEXT       path to the evaluation context JSON
 *   LOOP_DIFF          path to the unified diff of the pull request
 *   LOOP_REVIEW_OUTPUT path to the review agent's raw output (optional)
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
import { parseUnifiedDiff } from '../src/diff.ts'
import { decideMerge } from '../src/merge-gate.ts'
import { parsePolicy } from '../src/policy.ts'
import { mergeReview, parseReviewText, type ReviewResult } from '../src/review.ts'
import { classifyRisk } from '../src/risk.ts'
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

const reviewOutputPath = process.env.LOOP_REVIEW_OUTPUT
const agentReview: ReviewResult =
  reviewOutputPath === undefined || reviewOutputPath.trim() === ''
    ? unavailableReview('no review agent is configured')
    : !existsSync(reviewOutputPath)
      ? unavailableReview('the review agent wrote no output')
      : parseReviewText(readFileSync(reviewOutputPath, 'utf8')).result

const deterministic = runDeterministicChecks(diff)
const review = mergeReview(agentReview, deterministic, policy.review.blockingSeverity)

const risk = classifyRisk({
  diff,
  labels: [...context.pullRequest.labels, ...context.issueLabels],
  policy,
})

const issue = closingIssue(context.pullRequest.body)
const previous = parseLoopState(context.stickyComment, issue)

const outcome = decideMerge({
  risk: risk.risk,
  review,
  checks: context.checks,
  requiredChecks: context.requiredChecks,
  reviewAttempts: previous.reviewAttempts,
  maxReviewAttempts: policy.retry.maxReviewAttempts,
  humanApprovals: context.humanApprovals,
  isFork: context.pullRequest.isFork,
  isDraft: context.pullRequest.isDraft,
  blockingSeverity: policy.review.blockingSeverity,
})

const state = recordRound({
  state: { ...previous, issue },
  headSha: context.pullRequest.headSha,
  reviewStatus: review.status,
  decision: outcome.decision,
  at: new Date().toISOString(),
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
})

const outputDir = process.env.LOOP_OUTPUT_DIR ?? '.loop'
mkdirSync(outputDir, { recursive: true })

writeFileSync(
  join(outputDir, 'result.json'),
  `${JSON.stringify({ risk, review, outcome, state, issue }, null, 2)}\n`,
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
