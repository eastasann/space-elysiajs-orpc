import { z } from 'zod'
import { SeveritySchema } from './policy.ts'
import type { Finding } from './review.ts'

/**
 * The compact, storable shape of a finding.
 *
 * This is what survives in the sticky comment's embedded state across rounds —
 * not the full `Finding`, whose `suggested_action` and `source` add nothing to
 * "was this raised before" and whose `description` can run to 2000 characters.
 * Keeping this small is what lets several rounds' worth live in one comment.
 */
export const FindingRecordSchema = z.object({
  severity: SeveritySchema,
  file: z.string().max(512).nullable(),
  description: z.string().max(320),
  category: z.string().max(64),
})
export type FindingRecord = z.infer<typeof FindingRecordSchema>

/** Findings retained per round. Bounds how much one attempt can add to the comment. */
export const MAX_RETAINED_FINDINGS = 10

export function toFindingRecord(finding: Finding): FindingRecord {
  return {
    severity: finding.severity,
    file: finding.file ?? null,
    description: finding.description.slice(0, 320),
    category: finding.category,
  }
}

/**
 * Words too common to say anything about what a finding actually describes.
 * Filtering them out before comparing two findings is what lets a reworded
 * restatement still match — the review agent is not deterministic and never
 * repeats a finding in the same sentence twice, but it keeps the nouns.
 */
const STOPWORDS = new Set([
  'this',
  'that',
  'these',
  'those',
  'with',
  'from',
  'into',
  'across',
  'only',
  'never',
  'every',
  'each',
  'both',
  'their',
  'they',
  'them',
  'there',
  'here',
  'over',
  'under',
  'been',
  'were',
  'have',
  'does',
  'should',
  'would',
  'could',
  'also',
  'when',
  'which',
  'while',
  'still',
  'more',
  'most',
  'same',
  'other',
  'than',
  'then',
  'about',
])

function significantTerms(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length >= 4 && !STOPWORDS.has(word))
  return new Set(words)
}

/** Fraction of the smaller term set also present in the larger one. */
function overlapCoefficient(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let intersection = 0
  for (const term of a) if (b.has(term)) intersection += 1
  return intersection / Math.min(a.size, b.size)
}

const SIMILARITY_THRESHOLD = 0.5

/**
 * Whether two findings describe the same underlying defect.
 *
 * Exact text is not the test — the review agent re-words the same defect
 * between attempts. A finding tied to a file must match that file, since the
 * agent is precise about locations even when it is not precise about prose;
 * a finding with no file (a cross-cutting defect) is compared on wording
 * alone. Wording is compared on the words that carry meaning, not on the
 * sentence they happen to appear in.
 */
export function findingsMatch(a: FindingRecord, b: FindingRecord): boolean {
  if (a.file !== null && b.file !== null && a.file !== b.file) return false
  const similarity = overlapCoefficient(
    significantTerms(a.description),
    significantTerms(b.description),
  )
  return similarity >= SIMILARITY_THRESHOLD
}

export interface RecurrenceOccurrence {
  attempt: number
  headSha: string
}

export interface RecurringFinding {
  finding: Finding
  occurrences: RecurrenceOccurrence[]
}

export interface HistoryFindingsEntry {
  headSha: string
  attempt: number
  findings: readonly FindingRecord[]
}

/**
 * Match this round's findings against every earlier attempt's retained
 * findings, so a fix round can be told a finding already survived one.
 *
 * Only entries from a different head commit count as a prior attempt — a
 * check reporting late and re-evaluating the same commit is not a second try
 * at fixing anything, so it cannot make a finding look like it recurred.
 */
export function detectRecurrence(
  currentFindings: readonly Finding[],
  history: readonly HistoryFindingsEntry[],
  currentHeadSha: string,
): RecurringFinding[] {
  const priorAttempts = history.filter(
    (entry) => entry.headSha !== currentHeadSha && entry.findings.length > 0,
  )

  const recurring: RecurringFinding[] = []
  for (const finding of currentFindings) {
    const record = toFindingRecord(finding)
    const occurrences = new Map<string, RecurrenceOccurrence>()

    for (const entry of priorAttempts) {
      if (occurrences.has(entry.headSha)) continue
      if (entry.findings.some((prior) => findingsMatch(record, prior))) {
        occurrences.set(entry.headSha, { attempt: entry.attempt, headSha: entry.headSha })
      }
    }

    if (occurrences.size > 0) {
      recurring.push({ finding, occurrences: [...occurrences.values()] })
    }
  }

  return recurring
}
