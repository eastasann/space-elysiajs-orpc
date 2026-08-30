/**
 * Local execution plane for the autonomous issue-to-merge loop.
 *
 * The control plane — risk classification, the review gate, the merge decision —
 * lives in `@newsdeck/loop` and runs in GitHub Actions. This package runs a
 * coding agent on a developer's own machine and feeds its output into that
 * control plane through ordinary pull requests. It has no merge authority and
 * cannot grant itself any.
 */

export type {
  CodingAgent,
  CodingOutcome,
  CodingTask,
  ReviewAgent,
  ReviewOutcome,
  ReviewTask,
} from './agent.ts'
export { branchName, isAgentBranch, slugify, worktreeName } from './branch.ts'
export {
  type AuthStatus,
  authStatusSchema,
  type ClaudeAvailability,
  type ClaudeInvocation,
  type ClaudeResult,
  claudeResultSchema,
  interpretInvocation,
  probeClaude,
} from './claude.ts'
export {
  ClaudeCodeCodingAgent,
  ClaudeCodeReviewAgent,
  extractReview,
  formatFeedback,
  REVIEW_JSON_SCHEMA,
} from './claude-agent.ts'
export {
  INSTALL_STEP,
  loadConfig,
  type RunnerConfig,
  runnerConfigSchema,
  VERIFICATION_STEPS,
  type VerificationStep,
} from './config.ts'
export { filteredEnvironment, type RunOptions, type RunResult, resolveOnPath, run } from './exec.ts'
export {
  changedFiles,
  commitAll,
  currentBranch,
  ensureWorktree,
  fetchBase,
  type Git,
  gitIn,
  hasCommitsBeyond,
  isClean,
  pushBranch,
  removeWorktree,
  repositoryRoot,
} from './git.ts'
export {
  type ChecksVerdict,
  createGhClient,
  type GhAvailability,
  type GhClient,
  GhError,
  type GhIssue,
  type GhPullRequest,
  probeGh,
  summariseChecks,
} from './github.ts'
export {
  type Attempt,
  appendAttempt,
  emptyJournal,
  findRun,
  type Journal,
  type RunRecord,
  readJournal,
  upsertRun,
  writeJournal,
} from './journal.ts'
export { type AcquireOutcome, acquireLock, type LockFile, readLock } from './lock.ts'
export {
  type IssueOutcome,
  type OnceResult,
  pullRequestBody,
  type RunnerDeps,
  runOnce,
  type StopReason,
  type WorkOptions,
  workIssue,
} from './orchestrator.ts'
export { formatPreflight, type Preflight, preflight } from './preflight.ts'
export { cap, fence, loadTemplate, type PromptName, render } from './prompts.ts'
export { redact, redactJson } from './redact.ts'
export { publishable, RUNNER_MARKER, renderRunnerComment } from './report.ts'
export { type ReviewCommandResult, renderReview, reviewPullRequest } from './review-command.ts'
export {
  formatVerification,
  type StepResult,
  type VerificationOutcome,
  verify,
} from './verify.ts'
