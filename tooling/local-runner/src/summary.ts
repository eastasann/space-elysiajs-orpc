import type { RiskLevel } from '@newsdeck/loop'

/**
 * What an unattended session did.
 *
 * Printed when the runner stops, for whatever reason, and written as JSON
 * alongside. A loop that ran overnight and says nothing is indistinguishable
 * from one that crashed at midnight, so the summary is part of the contract
 * rather than a nicety.
 */

export interface IssueRecord {
  issue: number
  title: string
  pullRequest: number | null
  risk: RiskLevel | null
  outcome: 'merged' | 'open' | 'blocked' | 'skipped'
  detail: string
}

export interface RunSummary {
  startedAt: string
  finishedAt: string
  mode: 'attended' | 'unattended'
  stopReason: string
  issues: IssueRecord[]
  modelInvocations: number
  runtimeMs: number
}

export function emptySummary(mode: RunSummary['mode'], startedAt = new Date()): RunSummary {
  return {
    startedAt: startedAt.toISOString(),
    finishedAt: startedAt.toISOString(),
    mode,
    stopReason: 'still running',
    issues: [],
    modelInvocations: 0,
    runtimeMs: 0,
  }
}

/** Replace an issue's record, or append it. Keyed by issue number. */
export function recordIssue(summary: RunSummary, record: IssueRecord): RunSummary {
  const rest = summary.issues.filter((existing) => existing.issue !== record.issue)
  return { ...summary, issues: [...rest, record].sort((a, b) => a.issue - b.issue) }
}

function section(title: string, records: readonly IssueRecord[]): string[] {
  if (records.length === 0) return []
  return [
    `${title}:`,
    ...records.map((record) => {
      const pr = record.pullRequest === null ? '' : ` (PR #${record.pullRequest})`
      const risk = record.risk === null ? '' : ` [${record.risk}]`
      return `  #${record.issue}${risk}${pr} — ${record.detail}`
    }),
    '',
  ]
}

export function formatSummary(summary: RunSummary): string {
  const by = (outcome: IssueRecord['outcome']) =>
    summary.issues.filter((record) => record.outcome === outcome)

  const merged = by('merged')
  const hours = summary.runtimeMs / 3_600_000

  return [
    '',
    '─'.repeat(64),
    `Unattended run summary (${summary.mode})`,
    '─'.repeat(64),
    '',
    ...section('Completed', merged),
    ...section('Open (pull request raised, not yet merged)', by('open')),
    ...section('Blocked', by('blocked')),
    ...section('Skipped', by('skipped')),
    `Pull requests merged: ${
      merged.length === 0 ? 'none' : merged.map((record) => `#${record.pullRequest}`).join(', ')
    }`,
    `Model invocations:    ${summary.modelInvocations}`,
    `Runtime:              ${hours < 1 ? `${Math.round(summary.runtimeMs / 60_000)}m` : `${hours.toFixed(1)}h`}`,
    '',
    `Stopped because: ${summary.stopReason}`,
    '',
  ].join('\n')
}
