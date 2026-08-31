import type { DiffFile, PullRequestDiff } from './diff.ts'
import { matchesAnyGlob } from './glob.ts'
import { isAtLeastSeverity, type LoopPolicy, type RiskLevel } from './policy.ts'
import type { Finding } from './review.ts'

/**
 * Protection for the rules the loop uses to govern itself.
 *
 * An autonomous system that can rewrite its own merge policy has no merge
 * policy. Everything here answers one question: is this change *weakening* a
 * protection, as opposed to merely altering one? Changing the control plane is
 * allowed — an issue can legitimately ask for it — but a change that lowers the
 * bar has to be visible, and the loop must not be able to make its own current
 * pull request easier to merge.
 *
 * Every function is a pure comparison of the base-branch policy against the
 * proposed one. No model opinion participates.
 */

export interface ControlPlaneAssessment {
  /** The change touches a file the loop uses to govern itself. */
  affected: boolean
  /** It changes what the rules *say*, not merely surrounding prose. */
  policyBearing: boolean
  files: string[]
  reasons: string[]
}

/**
 * Decide whether a diff reaches the control plane, and whether it is policy.
 *
 * The two are not the same, and conflating them is what made the first live run
 * classify a documentation fix as high risk. A file under `controlPlane.patterns`
 * is always control plane. `AGENTS.md` and the loop documentation are control
 * plane only when the lines they change carry policy meaning — correcting a
 * stale command in `AGENTS.md` is documentation; changing what `AGENTS.md` says
 * an agent may merge is policy.
 */
export function assessControlPlane(
  diff: PullRequestDiff,
  policy: LoopPolicy,
): ControlPlaneAssessment {
  const signals = policy.controlPlane.policySignals.map((pattern) => new RegExp(pattern, 'i'))

  const files: string[] = []
  const reasons: string[] = []
  let policyBearing = false

  for (const file of diff.files) {
    const structural = matchesAnyGlob(policy.controlPlane.patterns, file.path)
    const always = matchesAnyGlob(policy.controlPlane.alwaysPolicy, file.path)
    const bySignal = changedLinesCarryPolicy(file, signals)

    if (!structural && !always && bySignal === null) continue

    files.push(file.path)

    if (always) {
      policyBearing = true
      reasons.push(`\`${file.path}\` is policy by definition`)
      continue
    }
    if (bySignal !== null) {
      policyBearing = true
      reasons.push(`\`${file.path}\` changes a line matching \`${bySignal}\``)
      continue
    }
    // Structural but with no policy-bearing line: still control plane, so it
    // gets the strongest verification, but it is not a rules change.
    reasons.push(`\`${file.path}\` is part of the loop's own machinery`)
  }

  return { affected: files.length > 0, policyBearing, files, reasons }
}

/** The first policy signal any changed line matches, or null. */
function changedLinesCarryPolicy(file: DiffFile, signals: readonly RegExp[]): string | null {
  for (const line of [...file.addedLines, ...file.removedLines]) {
    for (const signal of signals) {
      if (signal.test(line)) return signal.source
    }
  }
  return null
}

/**
 * Workflow constructs that hand a pull request more power than it should have.
 *
 * Matched against added lines only. Removing one of these is an improvement;
 * introducing one is the finding.
 */
const UNSAFE_WORKFLOW_PATTERNS: Array<{ pattern: RegExp; detail: string }> = [
  {
    pattern: /^\s*pull_request_target\s*:/,
    detail:
      '`pull_request_target` runs with repository secrets against untrusted pull request code.',
  },
  {
    pattern: /^\s*permissions\s*:\s*write-all\s*$/,
    detail: '`permissions: write-all` grants every scope rather than the ones needed.',
  },
  {
    pattern: /ACTIONS_STEP_DEBUG|ACTIONS_RUNNER_DEBUG/,
    detail: 'Debug logging can print secret values into a public log.',
  },
  {
    pattern: /\bcurl\b[^|\n]*\|\s*(?:ba)?sh\b/,
    detail: 'Piping a downloaded script straight into a shell executes unreviewed code.',
  },
  {
    pattern:
      /\$\{\{\s*github\.event\.(?:issue|pull_request|comment|review)\.[a-z_.]*(?:body|title)/,
    detail:
      'Interpolating issue or pull request text into a run step is command injection: the text is written by whoever can comment.',
  },
]

export interface ProtectionInput {
  /** Policy as it exists on the branch being merged into. The trusted one. */
  base: LoopPolicy
  /** Policy as the pull request proposes it. */
  head: LoopPolicy
  diff: PullRequestDiff
}

/**
 * Find every way a proposed policy is weaker than the one in force.
 *
 * Returns findings rather than a boolean so the reasons reach the pull request
 * comment. A change that trips any of these still *may* be right — an issue can
 * legitimately ask for a policy to be relaxed — but it stops being something
 * the loop can merge on its own.
 */
export function findWeakenedProtections(input: ProtectionInput): Finding[] {
  const findings: Finding[] = []

  const add = (description: string, action: string, severity: Finding['severity'] = 'critical') => {
    findings.push({
      severity,
      file: '.github/loop-policy.json',
      line: null,
      description,
      suggested_action: action,
      source: 'control-plane',
      category: 'policy',
    })
  }

  for (const check of input.base.requiredChecks) {
    if (!input.head.requiredChecks.includes(check)) {
      add(
        `Required check \`${check}\` was removed from the policy.`,
        'Restore it, or raise a dedicated issue to retire the check with a stated reason.',
      )
    }
  }

  for (const level of ['low', 'medium', 'high'] as const) {
    const before = input.base.tiers[level]
    const after = input.head.tiers[level]

    if (after.reviewers < before.reviewers) {
      add(
        `The \`${level}\` tier's independent review count dropped from ${before.reviewers} to ${after.reviewers}.`,
        'Restore the review count. Fewer independent reviewers is strictly less verification.',
      )
    }

    const removed = before.steps
      .map((step) => step.name)
      .filter((name) => !after.steps.some((step) => step.name === name))
    if (removed.length > 0) {
      add(
        `The \`${level}\` tier lost verification step(s): ${removed.join(', ')}.`,
        'Restore the steps, or state in the issue why the check no longer applies.',
      )
    }
  }

  // A *higher* blocking severity means fewer findings block a merge.
  if (
    input.head.review.blockingSeverity !== input.base.review.blockingSeverity &&
    isAtLeastSeverity(input.head.review.blockingSeverity, input.base.review.blockingSeverity)
  ) {
    add(
      `Blocking severity was raised from \`${input.base.review.blockingSeverity}\` to \`${input.head.review.blockingSeverity}\`, so fewer findings now stop a merge.`,
      'Keep the base severity unless an issue explicitly asks for the change.',
    )
  }

  const baseRules = new Set(
    input.base.risk.paths.flatMap((rule) => rule.patterns.map((p) => `${rule.risk}:${p}`)),
  )
  for (const rule of input.base.risk.paths) {
    for (const pattern of rule.patterns) {
      const stillThere = input.head.risk.paths.some(
        (candidate) => candidate.risk === rule.risk && candidate.patterns.includes(pattern),
      )
      const downgraded = input.head.risk.paths.some(
        (candidate) => candidate.patterns.includes(pattern) && candidate.risk !== rule.risk,
      )
      if (!stillThere && !downgraded) {
        add(
          `Risk rule \`${rule.risk}\` for \`${pattern}\` was removed, so those files now fall to a lower tier.`,
          'Restore the rule, or move the pattern deliberately and say so in the issue.',
        )
      }
    }
  }
  void baseRules

  for (const [category, before, after] of [
    ['coding fix rounds', input.base.retry.codingFixRounds, input.head.retry.codingFixRounds],
    ['review fix rounds', input.base.retry.reviewFixRounds, input.head.retry.reviewFixRounds],
    ['CI fix rounds', input.base.retry.ciFixRounds, input.head.retry.ciFixRounds],
  ] as const) {
    // Raising a retry limit is not a safety problem, but a large jump is a
    // runaway-cost problem, so it is worth a visible, non-blocking note.
    if (after > before * 2) {
      findings.push({
        severity: 'medium',
        file: '.github/loop-policy.json',
        line: null,
        description: `${category} more than doubled, from ${before} to ${after}.`,
        suggested_action: 'Confirm the issue asked for this; it multiplies model usage per issue.',
        source: 'control-plane',
        category: 'policy',
      })
    }
  }

  findings.push(...findUnsafeWorkflowChanges(input.diff))
  return findings
}

/** Unsafe constructs introduced into a workflow by this diff. */
export function findUnsafeWorkflowChanges(diff: PullRequestDiff): Finding[] {
  const findings: Finding[] = []

  for (const file of diff.files) {
    if (!matchesAnyGlob(['.github/workflows/**'], file.path)) continue

    for (const { pattern, detail } of UNSAFE_WORKFLOW_PATTERNS) {
      if (!file.addedLines.some((line) => pattern.test(line))) continue
      findings.push({
        severity: 'critical',
        file: file.path,
        line: null,
        description: `This workflow change introduces an unsafe construct. ${detail}`,
        suggested_action:
          'Remove it. If the workflow genuinely needs this, it belongs in its own issue with a stated threat model.',
        source: 'control-plane',
        category: 'security',
      })
    }
  }

  return findings
}

/**
 * Risk under the stricter of two policies.
 *
 * A pull request that edits the risk policy must not be able to classify
 * itself. Evaluating under both the trusted base policy and the proposed one
 * and taking the higher result means "change the policy so this counts as low
 * risk" cannot buy a cheaper merge — the base policy still applies to the very
 * change that proposes to replace it.
 */
export function stricterRisk(base: RiskLevel, proposed: RiskLevel): RiskLevel {
  const order: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2 }
  return order[base] >= order[proposed] ? base : proposed
}
