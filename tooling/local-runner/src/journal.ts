import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { z } from 'zod'

/**
 * The local runner's journal.
 *
 * GitHub remains the state store for anything that decides an outcome — labels,
 * check runs, the sticky pull request comment. This file holds only what is
 * local and cannot live there: which worktree belongs to which issue, how many
 * fix rounds this machine has spent, and where the logs went.
 *
 * Deleting it must never corrupt the loop. It is a convenience for resuming and
 * for `loop:status`, not a source of truth.
 */

export const attemptSchema = z.object({
  at: z.string(),
  phase: z.enum(['implement', 'verify', 'review', 'fix', 'publish']),
  outcome: z.enum(['ok', 'failed', 'skipped']),
  /** Redacted, human-readable. Never a raw agent transcript. */
  detail: z.string().max(2000),
})
export type Attempt = z.infer<typeof attemptSchema>

export const runRecordSchema = z.object({
  issue: z.number().int().positive(),
  branch: z.string().max(255),
  worktree: z.string().max(4096),
  startedAt: z.string(),
  updatedAt: z.string(),
  status: z.enum(['in-progress', 'awaiting-review', 'blocked', 'done']),
  /** Coding rounds spent locally. Bounds LOOP_CODING_FIX_ROUNDS. */
  fixRounds: z.number().int().min(0).max(100).default(0),
  /** Rounds spent responding to failing CI. Bounds LOOP_CI_FIX_ROUNDS. */
  ciRounds: z.number().int().min(0).max(100).default(0),
  /** Attempts at resolving a merge conflict. Bounds LOOP_CONFLICT_ROUNDS. */
  conflictRounds: z.number().int().min(0).max(100).default(0),
  pullRequest: z.number().int().positive().nullable().default(null),
  /** Risk this machine computed. Advisory: the workflow recomputes it. */
  risk: z.enum(['low', 'medium', 'high']).nullable().default(null),
  attempts: z.array(attemptSchema).max(100).default([]),
})
export type RunRecord = z.infer<typeof runRecordSchema>

export const journalSchema = z.object({
  version: z.literal(1),
  runs: z.array(runRecordSchema).max(200).default([]),
})
export type Journal = z.infer<typeof journalSchema>

export function emptyJournal(): Journal {
  return { version: 1, runs: [] }
}

/** Read the journal, falling back to an empty one for anything unreadable. */
export async function readJournal(path: string): Promise<Journal> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch {
    return emptyJournal()
  }

  try {
    const parsed = journalSchema.safeParse(JSON.parse(text))
    return parsed.success ? parsed.data : emptyJournal()
  } catch {
    return emptyJournal()
  }
}

export async function writeJournal(path: string, journal: Journal): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(journal, null, 2)}\n`, 'utf8')
}

export function findRun(journal: Journal, issue: number): RunRecord | undefined {
  return journal.runs.find((run) => run.issue === issue)
}

/** Insert or replace the record for an issue, newest first. */
export function upsertRun(journal: Journal, run: RunRecord): Journal {
  const rest = journal.runs.filter((existing) => existing.issue !== run.issue)
  return { ...journal, runs: [run, ...rest].slice(0, 200) }
}

export function appendAttempt(run: RunRecord, attempt: Attempt): RunRecord {
  return {
    ...run,
    updatedAt: attempt.at,
    attempts: [...run.attempts, attempt].slice(-100),
  }
}
