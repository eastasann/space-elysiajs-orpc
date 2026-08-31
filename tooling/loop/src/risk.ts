import { assessControlPlane, stricterRisk } from './control-plane.ts'
import { dependencyChanges, findDestructiveSql, removedExports } from './detect.ts'
import type { PullRequestDiff } from './diff.ts'
import { deletions } from './diff.ts'
import { matchesAnyGlob } from './glob.ts'
import { type LoopPolicy, maxRisk, type RiskLevel } from './policy.ts'

export interface RiskReason {
  risk: RiskLevel
  /** Where the classification came from. Labels and paths are auditable inputs. */
  source: 'default' | 'path' | 'label' | 'escalation' | 'control-plane' | 'base-policy'
  detail: string
}

export interface RiskAssessment {
  risk: RiskLevel
  reasons: RiskReason[]
  /** Set when the change reaches the loop's own machinery. */
  controlPlane?: { affected: boolean; policyBearing: boolean; reasons: string[] }
}

const RISK_LABEL = /^risk:(low|medium|high)$/

export interface RiskInput {
  diff: PullRequestDiff
  /** Labels from the pull request and its issue, combined. */
  labels: readonly string[]
  policy: LoopPolicy
}

/**
 * Classify a pull request's risk.
 *
 * Deterministic by construction: the inputs are the diff, the labels and the
 * policy file. No model output participates, because this value decides whether
 * a change may merge without a human.
 *
 * Risk only ever moves **up**. An explicit `risk:` label can escalate a change
 * but can never mark a sensitive path as safe — otherwise the cheapest way past
 * the human gate would be to add a label.
 */
export function classifyRisk({ diff, labels, policy }: RiskInput): RiskAssessment {
  const reasons: RiskReason[] = [
    { risk: policy.risk.default, source: 'default', detail: 'policy default' },
  ]
  let risk = policy.risk.default

  for (const rule of policy.risk.paths) {
    const matched = diff.files.filter((file) => matchesAnyGlob(rule.patterns, file.path))
    if (matched.length === 0) continue

    risk = maxRisk(risk, rule.risk)
    reasons.push({
      risk: rule.risk,
      source: 'path',
      detail: `${rule.reason} (${matched.length} file(s), e.g. ${matched[0]?.path})`,
    })
  }

  for (const label of labels) {
    const match = RISK_LABEL.exec(label)
    if (match?.[1] === undefined) continue

    const declared = match[1] as RiskLevel
    risk = maxRisk(risk, declared)
    reasons.push({ risk: declared, source: 'label', detail: `label \`${label}\`` })
  }

  for (const escalation of escalations({ diff, labels, policy })) {
    risk = maxRisk(risk, escalation.risk)
    reasons.push(escalation)
  }

  // Reaching the loop's own machinery is high risk on its own, whatever the
  // paths said. A one-line edit to the merge gate is not a small change.
  const controlPlane = assessControlPlane(diff, policy)
  if (controlPlane.affected) {
    risk = maxRisk(risk, 'high')
    for (const reason of controlPlane.reasons) {
      reasons.push({ risk: 'high', source: 'control-plane', detail: reason })
    }
  }

  return {
    risk,
    reasons,
    controlPlane: {
      affected: controlPlane.affected,
      policyBearing: controlPlane.policyBearing,
      reasons: controlPlane.reasons,
    },
  }
}

export interface MonotonicRiskInput {
  diff: PullRequestDiff
  labels: readonly string[]
  /** Policy on the branch being merged into. Trusted. */
  basePolicy: LoopPolicy
  /**
   * Policy the pull request proposes, when it changes one.
   *
   * Omitted — or identical to the base — for the overwhelming majority of
   * changes, which touch no policy at all.
   */
  headPolicy?: LoopPolicy
}

/**
 * Classify risk so that a pull request cannot lower its own.
 *
 * The change is evaluated under the trusted base-branch policy *and* under
 * whatever policy it proposes, and the stricter answer wins. Without this, the
 * cheapest route to an automatic merge would be to add a rule saying the change
 * is low risk — the policy file would be classifying itself.
 */
export function classifyRiskMonotonic(input: MonotonicRiskInput): RiskAssessment {
  const base = classifyRisk({ diff: input.diff, labels: input.labels, policy: input.basePolicy })

  if (input.headPolicy === undefined) return base

  const head = classifyRisk({ diff: input.diff, labels: input.labels, policy: input.headPolicy })
  const risk = stricterRisk(base.risk, head.risk)

  const reasons = [...base.reasons]
  if (head.risk !== base.risk) {
    reasons.push({
      risk,
      source: 'base-policy',
      detail:
        risk === base.risk
          ? `the proposed policy would call this \`${head.risk}\`; the base branch's policy governs, so it stays \`${base.risk}\``
          : `the proposed policy raises this to \`${head.risk}\``,
    })
  }

  return {
    risk,
    reasons,
    controlPlane: {
      affected: (base.controlPlane?.affected ?? false) || (head.controlPlane?.affected ?? false),
      policyBearing:
        (base.controlPlane?.policyBearing ?? false) || (head.controlPlane?.policyBearing ?? false),
      reasons: [...(base.controlPlane?.reasons ?? [])],
    },
  }
}

function escalations({ diff, policy }: RiskInput): RiskReason[] {
  const found: RiskReason[] = []
  const { escalations: rules } = policy.risk

  if (diff.files.length > rules.maxChangedFiles) {
    found.push({
      risk: 'high',
      source: 'escalation',
      detail: `${diff.files.length} files changed, over the ${rules.maxChangedFiles} file limit (large-scale restructuring)`,
    })
  }

  const removedLines = deletions(diff)
  if (removedLines > rules.maxDeletedLines) {
    found.push({
      risk: 'high',
      source: 'escalation',
      detail: `${removedLines} lines deleted, over the ${rules.maxDeletedLines} line limit (large-scale deletion)`,
    })
  }

  for (const file of diff.files) {
    if (!matchesAnyGlob(rules.destructiveMigrationGlobs, file.path)) continue
    const destructive = findDestructiveSql(file.addedLines)
    if (destructive.length > 0) {
      found.push({
        risk: 'high',
        source: 'escalation',
        detail: `destructive migration in ${file.path}: ${destructive[0]?.line}`,
      })
    }
  }

  for (const file of diff.files) {
    if (!matchesAnyGlob(rules.publicContractGlobs, file.path)) continue
    const removed = removedExports(file)
    if (removed.length > 0) {
      found.push({
        risk: 'high',
        source: 'escalation',
        detail: `breaking public API change: ${file.path} no longer exports ${removed.join(', ')}`,
      })
    }
  }

  for (const file of diff.files) {
    for (const change of dependencyChanges(file)) {
      if (change.major && change.kind === 'upgraded') {
        found.push({
          risk: 'high',
          source: 'escalation',
          detail: `major dependency upgrade: ${change.name} ${change.from} -> ${change.to}`,
        })
      }
    }
  }

  return found
}
