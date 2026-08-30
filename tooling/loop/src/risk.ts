import { dependencyChanges, findDestructiveSql, removedExports } from './detect.ts'
import type { PullRequestDiff } from './diff.ts'
import { deletions } from './diff.ts'
import { matchesAnyGlob } from './glob.ts'
import { type LoopPolicy, maxRisk, type RiskLevel } from './policy.ts'

export interface RiskReason {
  risk: RiskLevel
  /** Where the classification came from. Labels and paths are auditable inputs. */
  source: 'default' | 'path' | 'label' | 'escalation'
  detail: string
}

export interface RiskAssessment {
  risk: RiskLevel
  reasons: RiskReason[]
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

  return { risk, reasons }
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
