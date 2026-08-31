/**
 * Classify a pull request's risk, ahead of the review passes.
 *
 * The gate recomputes this itself — `classifyRiskMonotonic` is pure, so running
 * it twice is free and cannot disagree. It exists as a separate step because
 * the workflow has to know the tier *before* it decides how many independent
 * reviewers to run, and the reviewers run before the gate.
 *
 * Reads:
 *   LOOP_CONTEXT         path to the evaluation context JSON
 *   LOOP_DIFF            path to the unified diff
 *   LOOP_POLICY          trusted policy, from the default branch
 *   LOOP_PROPOSED_POLICY policy as the pull request proposes it (optional)
 *
 * Writes `risk` and `reviewers` to $GITHUB_OUTPUT.
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { parseUnifiedDiff } from '../src/diff.ts'
import { parsePolicy, reviewersForRisk } from '../src/policy.ts'
import { classifyRiskMonotonic } from '../src/risk.ts'
import { EvaluationContextSchema } from './context.ts'

function required(name: string): string {
  const value = process.env[name]
  if (value === undefined || value.trim() === '') {
    throw new Error(`${name} is required`)
  }
  return value
}

const policy = parsePolicy(
  JSON.parse(readFileSync(process.env.LOOP_POLICY ?? '.github/loop-policy.json', 'utf8')),
)

const proposedPath = process.env.LOOP_PROPOSED_POLICY
const proposed =
  proposedPath !== undefined && proposedPath !== '' && existsSync(proposedPath)
    ? tryParse(proposedPath)
    : undefined

const context = EvaluationContextSchema.parse(
  JSON.parse(readFileSync(required('LOOP_CONTEXT'), 'utf8')),
)
const diff = parseUnifiedDiff(readFileSync(required('LOOP_DIFF'), 'utf8'))

const assessment = classifyRiskMonotonic({
  diff,
  labels: [...context.pullRequest.labels, ...context.issueLabels],
  basePolicy: policy,
  headPolicy: proposed,
})

const reviewers = reviewersForRisk(policy, assessment.risk)

if (process.env.GITHUB_OUTPUT !== undefined) {
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    `risk=${assessment.risk}\nreviewers=${reviewers}\ncontrol_plane=${assessment.controlPlane?.affected === true}\n`,
  )
}

process.stdout.write(
  `risk=${assessment.risk} reviewers=${reviewers} control-plane=${assessment.controlPlane?.affected === true}\n`,
)

/**
 * A proposed policy that does not parse is ignored, not fatal.
 *
 * The base policy still governs, which is the strict direction: a pull request
 * cannot escape classification by shipping a malformed policy file.
 */
function tryParse(path: string) {
  try {
    return parsePolicy(JSON.parse(readFileSync(path, 'utf8')))
  } catch (error) {
    process.stderr.write(
      `The proposed policy could not be parsed; the base policy governs. ${String(error)}\n`,
    )
    return undefined
  }
}
