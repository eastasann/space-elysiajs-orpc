/**
 * Decision logic for the autonomous issue-to-merge loop.
 *
 * Every export here is a pure function of observable facts — the diff, the
 * labels, the check runs, the policy file. Nothing in this package calls
 * GitHub or a model; the workflows gather the facts and act on the answers.
 * That split is what makes the merge policy testable, and it is why
 * `test/scenarios.test.ts` can assert the whole gate without a network.
 */

export { runDeterministicChecks } from './checks/index.ts'
export {
  type DependencyDeclaration,
  parseDependencyDeclaration,
  parseIssueDependencies,
} from './dependencies.ts'
export {
  type DependencyChange,
  dependencyChanges,
  extractExportedNames,
  findDestructiveSql,
  removedExports,
} from './detect.ts'
export {
  additions,
  type DiffFile,
  DiffFileSchema,
  deletions,
  type PullRequestDiff,
  PullRequestDiffSchema,
  parseUnifiedDiff,
} from './diff.ts'
export {
  type Candidate,
  DEFAULT_SELECTION_POLICY,
  evaluateCandidates,
  type IssueSummary,
  type SelectionPolicy,
  type SelectionResult,
  selectNextIssue,
} from './eligibility.ts'
export { matchesAnyGlob, matchesGlob } from './glob.ts'
export {
  type CheckConclusion,
  type CheckState,
  decideMerge,
  type GateDecision,
  type GateInput,
  type GateOutcome,
} from './merge-gate.ts'
export {
  isAtLeastRisk,
  isAtLeastSeverity,
  type LoopPolicy,
  LoopPolicySchema,
  maxRisk,
  PolicyError,
  parsePolicy,
  type RiskLevel,
  RiskLevelSchema,
  type Severity,
  SeveritySchema,
} from './policy.ts'
export {
  blockingFindings,
  type Finding,
  FindingSchema,
  mergeReview,
  type ParseOutcome,
  parseReviewResult,
  parseReviewText,
  type ReviewResult,
  ReviewResultSchema,
  type ReviewStatus,
  ReviewStatusSchema,
  sanitiseForMarkdown,
} from './review.ts'
export { classifyRisk, type RiskAssessment, type RiskReason } from './risk.ts'
export {
  initialState,
  LOOP_STATE_MARKER,
  type LoopState,
  LoopStateSchema,
  parseLoopState,
  recordRound,
  serialiseLoopState,
} from './state.ts'
export {
  type PullRequestView,
  renderPullRequestSummary,
  renderSelectionSummary,
} from './summary.ts'
