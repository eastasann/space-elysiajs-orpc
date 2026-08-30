import { parseDependencyDeclaration } from './dependencies.ts'

export interface IssueSummary {
  number: number
  title: string
  state: 'open' | 'closed'
  labels: readonly string[]
  body: string | null
}

export interface DependencyState {
  number: number
  /** `false` when the dependency is open, or when it cannot be seen at all. */
  satisfied: boolean
  detail: string
}

export interface Candidate {
  issue: IssueSummary
  eligible: boolean
  reasons: string[]
  dependencies: DependencyState[]
}

export interface SelectionPolicy {
  /** Issues without this label are never picked up. Human vetting lives here. */
  requiredLabel: string
  /** Any of these present means the issue is already claimed or held. */
  excludedLabels: readonly string[]
  /**
   * Dependencies for issues whose body declares none, keyed by issue number.
   *
   * A body always wins: adopting the `Depends on:` convention on an issue
   * retires its entry here. See docs/loop-engineering.md#issue-dependencies.
   */
  fallbackDependencies?: Readonly<Record<number, readonly number[]>>
}

export const DEFAULT_SELECTION_POLICY: SelectionPolicy = {
  requiredLabel: 'agent:ready',
  excludedLabels: ['agent:in-progress', 'agent:review', 'agent:blocked'],
}

export interface SelectionResult {
  selected: IssueSummary | null
  candidates: Candidate[]
  /** Why nothing was selected. Present only when `selected` is null. */
  stopReason: string | null
}

/**
 * Assess every issue against the selection policy.
 *
 * Returns the reasoning for all of them, not only the winner, because "why did
 * the loop not pick anything up?" is the question a human actually asks.
 */
export function evaluateCandidates(
  issues: readonly IssueSummary[],
  policy: SelectionPolicy = DEFAULT_SELECTION_POLICY,
): Candidate[] {
  const byNumber = new Map(issues.map((issue) => [issue.number, issue]))

  return issues
    .filter((issue) => issue.state === 'open')
    .map((issue) => {
      const reasons: string[] = []

      if (!issue.labels.includes(policy.requiredLabel)) {
        reasons.push(`missing \`${policy.requiredLabel}\` label`)
      }
      for (const excluded of policy.excludedLabels) {
        if (issue.labels.includes(excluded)) reasons.push(`carries \`${excluded}\``)
      }

      const declaration = parseDependencyDeclaration(issue.body)
      const effective = declaration.declared
        ? declaration.dependencies
        : [...(policy.fallbackDependencies?.[issue.number] ?? [])]

      const dependencies: DependencyState[] = effective.map((number) => {
        const dependency = byNumber.get(number)
        if (dependency === undefined) {
          // Unknown means unverifiable, and unverifiable must not mean satisfied.
          return { number, satisfied: false, detail: `#${number} was not found` }
        }
        return {
          number,
          satisfied: dependency.state === 'closed',
          detail: `#${number} is ${dependency.state}`,
        }
      })

      const unmet = dependencies.filter((dependency) => !dependency.satisfied)
      if (unmet.length > 0) {
        reasons.push(`unmet dependencies: ${unmet.map((d) => `#${d.number}`).join(', ')}`)
      }

      return { issue, eligible: reasons.length === 0, reasons, dependencies }
    })
    .sort((a, b) => a.issue.number - b.issue.number)
}

/**
 * Pick the next issue for the coding agent.
 *
 * Lowest open issue number first, which follows the roadmap's dependency order.
 * Selection is advisory: the workflow must still claim the issue by applying
 * `agent:in-progress` and re-reading it, because GitHub offers no
 * compare-and-set on labels. See docs/loop-engineering.md.
 */
export function selectNextIssue(
  issues: readonly IssueSummary[],
  policy: SelectionPolicy = DEFAULT_SELECTION_POLICY,
): SelectionResult {
  const candidates = evaluateCandidates(issues, policy)
  const selected = candidates.find((candidate) => candidate.eligible)?.issue ?? null

  if (selected !== null) return { selected, candidates, stopReason: null }

  const ready = candidates.filter((candidate) =>
    candidate.issue.labels.includes(policy.requiredLabel),
  )

  const stopReason =
    candidates.length === 0
      ? 'no open issues'
      : ready.length === 0
        ? `no open issue carries the \`${policy.requiredLabel}\` label`
        : 'every ready issue is blocked, already claimed, or has unmet dependencies'

  return { selected: null, candidates, stopReason }
}
