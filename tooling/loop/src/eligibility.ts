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
   * Dependencies for issues whose body does not answer the question, keyed by
   * issue number.
   *
   * A body always wins once it does answer: naming a `#N` reference, or
   * writing `Depends on: none`, retires that issue's entry here. A block that
   * names nothing parsable — prose without an issue reference — has not
   * answered, so this map is still consulted. See
   * docs/loop-engineering.md#issue-dependencies.
   */
  fallbackDependencies?: Readonly<Record<number, readonly number[]>>
  /**
   * Priority labels, most urgent first.
   *
   * Ordering is entirely from GitHub metadata: priority label, then issue
   * number. Nothing here asks a model what to work on next — given the same
   * backlog, two runners pick the same issue, which is what makes a claim race
   * a rare collision rather than the normal case.
   *
   * An issue carrying none of these sorts after every issue that carries one,
   * so a backlog with no priority labels falls back to issue order unchanged.
   */
  priorityLabels?: readonly string[]
  /** Issues this run has already given up on. Skipped without re-reading. */
  skip?: readonly number[]
}

export const DEFAULT_PRIORITY_LABELS = [
  'priority:p0',
  'priority:p1',
  'priority:p2',
  'priority:p3',
] as const

export const DEFAULT_SELECTION_POLICY: SelectionPolicy = {
  requiredLabel: 'agent:ready',
  excludedLabels: ['agent:in-progress', 'agent:review', 'agent:blocked'],
  priorityLabels: DEFAULT_PRIORITY_LABELS,
}

/** Rank of an issue's priority label; unlabelled sorts last. */
export function priorityRank(
  labels: readonly string[],
  priorityLabels: readonly string[] = DEFAULT_PRIORITY_LABELS,
): number {
  for (const [index, label] of priorityLabels.entries()) {
    if (labels.includes(label)) return index
  }
  return priorityLabels.length
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

      // Issues this run already gave up on. They keep `agent:blocked` on
      // GitHub, so this is belt and braces against re-selecting one before the
      // label write lands.
      if (policy.skip?.includes(issue.number) === true) {
        reasons.push('already blocked earlier in this run')
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
    .sort((a, b) => {
      const byPriority =
        priorityRank(a.issue.labels, policy.priorityLabels) -
        priorityRank(b.issue.labels, policy.priorityLabels)
      return byPriority !== 0 ? byPriority : a.issue.number - b.issue.number
    })
}

/**
 * Pick the next issue for the coding agent.
 *
 * Highest priority label first, then lowest issue number, which follows the
 * roadmap's dependency order.
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
