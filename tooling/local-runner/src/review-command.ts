import { readFile } from 'node:fs/promises'
import { mergeReview, parsePolicy, type ReviewResult } from '@newsdeck/loop'
import type { ReviewAgent } from './agent.ts'
import type { GhClient } from './github.ts'
import { renderRunnerComment } from './report.ts'

/**
 * Review a pull request from the developer's machine.
 *
 * This is an *advisory* review, and the wording of what it publishes says so.
 * The review that gates the merge runs in GitHub Actions on the pull request,
 * where the code being reviewed cannot influence the runner. A local review is
 * useful for turning a round faster; it has no authority, and giving it any
 * would mean a laptop could approve its own change.
 */

export interface ReviewCommandDeps {
  gh: GhClient
  review: ReviewAgent
  repository: string
  policyPath: string
  log: (line: string) => void
  /** When false, the review is printed and not published. */
  publish: boolean
}

export interface ReviewCommandResult {
  pullRequest: number
  review: ReviewResult | null
  published: boolean
  detail: string
}

export async function reviewPullRequest(
  deps: ReviewCommandDeps,
  number: number,
): Promise<ReviewCommandResult> {
  const pullRequest = await deps.gh.pullRequest(number)
  const diff = await deps.gh.pullRequestDiff(number)

  deps.log(`Reviewing #${number} (${pullRequest.headRefName})`)

  const outcome = await deps.review.review({
    worktree: deps.repository,
    issue: number,
    title: `Pull request #${number}`,
    body: 'Review the diff below on its own terms.',
    base: 'the default branch',
    branch: pullRequest.headRefName,
    diff,
    changedFiles: fileNames(diff),
  })

  if (!outcome.ok) {
    return {
      pullRequest: number,
      review: null,
      published: false,
      detail: `The review agent did not return a usable result: ${outcome.reason}`,
    }
  }

  // Deterministic findings still take precedence, exactly as they do in the
  // workflow. A model that approves cannot clear a check this repository ran.
  const policy = parsePolicy(JSON.parse(await readFile(deps.policyPath, 'utf8')))
  const review = mergeReview(outcome.review, [], policy.review.blockingSeverity)

  if (!deps.publish) {
    return { pullRequest: number, review, published: false, detail: 'Not published (--dry-run).' }
  }

  await deps.gh.comment(
    number,
    renderRunnerComment({
      issue: number,
      branch: pullRequest.headRefName,
      agent: deps.review.name,
      phase: 'advisory review',
      body: renderReview(review),
    }),
  )

  return { pullRequest: number, review, published: true, detail: 'Posted as a comment.' }
}

function fileNames(diff: string): string[] {
  const names = new Set<string>()
  for (const line of diff.split('\n')) {
    const match = /^\+\+\+ b\/(.+)$/.exec(line)
    if (match?.[1] !== undefined && match[1] !== '/dev/null') names.add(match[1])
  }
  return [...names]
}

export function renderReview(review: ReviewResult): string {
  const lines = [`**Status:** \`${review.status}\``, '', review.summary]

  if (review.findings.length > 0) {
    lines.push('', '| Severity | Where | Finding | Suggested action |', '| --- | --- | --- | --- |')
    for (const finding of review.findings) {
      const where =
        finding.file == null
          ? '—'
          : `${finding.file}${finding.line == null ? '' : `:${finding.line}`}`
      lines.push(
        `| ${finding.severity} | ${where} | ${cell(finding.description)} | ${cell(finding.suggested_action)} |`,
      )
    }
  }

  lines.push('', '_Advisory only. The review that gates this pull request runs in GitHub Actions._')

  return lines.join('\n')
}

function cell(text: string): string {
  return text.replaceAll('|', '\\|').replaceAll('\n', ' ')
}
