import type { Article, NewArticle } from '@newsdeck/db/schema'
import type { ArticleCandidate } from '../../lib/feed-parser.ts'
import type { ArticleMatch, ArticlesRepository } from './repository.ts'

/** Which field the match was decided on. */
export type ArticleMatchReason = 'canonical-url' | 'content-hash'

export type ArticleOutcome =
  | { status: 'inserted'; article: Article }
  /** Already stored — either found before the write, or an insert lost the race to a concurrent one. */
  | { status: 'existing'; reason: ArticleMatchReason | 'race'; existingArticleId: string }
  /** Collapsed against an earlier candidate in the same batch, before any database write. */
  | { status: 'duplicate-in-batch'; reason: ArticleMatchReason; duplicateOfIndex: number }

export interface ArticleCandidateOutcome {
  index: number
  candidate: ArticleCandidate
  outcome: ArticleOutcome
}

export interface DedupeArticlesInput {
  sourceId: string
  /** When the collector fetched the feed this batch came from. */
  fetchedAt: Date
  candidates: ArticleCandidate[]
}

export interface DedupeArticlesResult {
  /** One entry per input candidate, in input order. */
  outcomes: ArticleCandidateOutcome[]
  insertedCount: number
  existingCount: number
  duplicateInBatchCount: number
}

export interface ArticlesService {
  /**
   * Decides, for a batch of candidates, which are new, which already exist,
   * and which duplicate another candidate in the same batch — then persists
   * the new ones.
   */
  dedupeAndPersist(input: DedupeArticlesInput): Promise<DedupeArticlesResult>
}

/**
 * Two candidates (or a candidate and a stored row) are the same article when
 * either their `canonical_url` or their `content_hash` matches — see
 * `ArticleCandidate.contentHash` in `../../lib/feed-parser.ts` for why the
 * hash alone can catch a republish under a different url.
 */
function isCanonicalUrlConflict(error: unknown): boolean {
  const cause = (error as { cause?: { code?: string; constraint_name?: string } } | undefined)
    ?.cause
  return cause?.code === '23505' && cause.constraint_name === 'articles_canonical_url_unique'
}

interface InBatchDuplicate {
  reason: ArticleMatchReason
  duplicateOfIndex: number
}

/**
 * Collapses duplicates within the batch before anything touches the
 * database. Candidates are grouped with a union-find over their indexes:
 * whichever key (`canonicalUrl` or `contentHash`) a candidate shares with an
 * earlier one merges their two groups, so a candidate that bridges two
 * groups already established independently — one by url, the other by hash —
 * folds both into one instead of leaving two representatives standing.
 */
function collapseInBatchDuplicates(candidates: ArticleCandidate[]): {
  representativeIndexes: number[]
  duplicates: Map<number, InBatchDuplicate>
} {
  const canonicalUrlToIndex = new Map<string, number>()
  const contentHashToIndex = new Map<string, number>()
  const parent = new Map<number, number>()
  const duplicates = new Map<number, InBatchDuplicate>()

  function find(index: number): number {
    const above = parent.get(index)
    if (above === undefined) return index
    const root = find(above)
    parent.set(index, root)
    return root
  }

  // The earlier-indexed root always wins, so the survivor of any merge is
  // the group's earliest candidate — matching the fact that a later
  // candidate can only ever be a duplicate of something already seen.
  function union(a: number, b: number, reason: ArticleMatchReason): void {
    const rootA = find(a)
    const rootB = find(b)
    if (rootA === rootB) return
    const winner = Math.min(rootA, rootB)
    const loser = Math.max(rootA, rootB)
    parent.set(loser, winner)
    duplicates.set(loser, { reason, duplicateOfIndex: winner })
  }

  candidates.forEach((candidate, index) => {
    const byUrl = canonicalUrlToIndex.get(candidate.canonicalUrl)
    const byHash = contentHashToIndex.get(candidate.contentHash)

    if (byUrl !== undefined) union(index, byUrl, 'canonical-url')
    if (byHash !== undefined) union(index, byHash, 'content-hash')

    canonicalUrlToIndex.set(candidate.canonicalUrl, index)
    contentHashToIndex.set(candidate.contentHash, index)
  })

  const representativeIndexes: number[] = []
  candidates.forEach((_, index) => {
    if (find(index) === index) {
      representativeIndexes.push(index)
      return
    }
    // A merge recorded further down the batch can fold this index's group
    // into yet another one afterwards — resolve to the final root so every
    // duplicate points at the representative that was actually looked up.
    const recorded = duplicates.get(index) as InBatchDuplicate
    duplicates.set(index, { ...recorded, duplicateOfIndex: find(index) })
  })

  return { representativeIndexes, duplicates }
}

function findMatch(
  candidate: ArticleCandidate,
  byCanonicalUrl: Map<string, ArticleMatch>,
  byContentHash: Map<string, ArticleMatch>,
): { match: ArticleMatch; reason: ArticleMatchReason } | null {
  const byUrl = byCanonicalUrl.get(candidate.canonicalUrl)
  if (byUrl !== undefined) return { match: byUrl, reason: 'canonical-url' }

  const byHash = byContentHash.get(candidate.contentHash)
  if (byHash !== undefined) return { match: byHash, reason: 'content-hash' }

  return null
}

function toNewArticle(candidate: ArticleCandidate, sourceId: string, fetchedAt: Date): NewArticle {
  return {
    sourceId,
    url: candidate.url,
    canonicalUrl: candidate.canonicalUrl,
    title: candidate.title,
    summary: candidate.summary,
    author: candidate.author,
    imageUrl: candidate.imageUrl,
    contentHash: candidate.contentHash,
    publishedAt: candidate.publishedAt,
    fetchedAt,
  }
}

export function createArticlesService(repository: ArticlesRepository): ArticlesService {
  return {
    async dedupeAndPersist({ sourceId, fetchedAt, candidates }) {
      const { representativeIndexes, duplicates } = collapseInBatchDuplicates(candidates)

      const matches = await repository.findMatches(
        representativeIndexes.map((index) => {
          const candidate = candidates[index] as ArticleCandidate
          return { canonicalUrl: candidate.canonicalUrl, contentHash: candidate.contentHash }
        }),
      )
      const byCanonicalUrl = new Map(matches.map((match) => [match.canonicalUrl, match]))
      const byContentHash = new Map(matches.map((match) => [match.contentHash, match]))

      const resolved = new Map<number, ArticleOutcome>()

      for (const index of representativeIndexes) {
        const candidate = candidates[index] as ArticleCandidate
        const found = findMatch(candidate, byCanonicalUrl, byContentHash)

        if (found !== null) {
          resolved.set(index, {
            status: 'existing',
            reason: found.reason,
            existingArticleId: found.match.id,
          })
          continue
        }

        try {
          const article = await repository.insert(toNewArticle(candidate, sourceId, fetchedAt))
          resolved.set(index, { status: 'inserted', article })
        } catch (error) {
          if (!isCanonicalUrlConflict(error)) throw error

          // Lost a race to a concurrent insert of the same article. The
          // unique constraint just proved it exists; find the row it is.
          const [raceMatch] = await repository.findMatches([
            { canonicalUrl: candidate.canonicalUrl, contentHash: candidate.contentHash },
          ])
          if (raceMatch === undefined) throw error

          resolved.set(index, {
            status: 'existing',
            reason: 'race',
            existingArticleId: raceMatch.id,
          })
        }
      }

      const outcomes: ArticleCandidateOutcome[] = candidates.map((candidate, index) => {
        const duplicate = duplicates.get(index)
        const outcome: ArticleOutcome | undefined = duplicate
          ? { status: 'duplicate-in-batch', ...duplicate }
          : resolved.get(index)
        if (outcome === undefined) {
          throw new Error(`no outcome computed for candidate at index ${index}`)
        }
        return { index, candidate, outcome }
      })

      let insertedCount = 0
      let existingCount = 0
      let duplicateInBatchCount = 0
      for (const { outcome } of outcomes) {
        if (outcome.status === 'inserted') insertedCount += 1
        else if (outcome.status === 'existing') existingCount += 1
        else duplicateInBatchCount += 1
      }

      return { outcomes, insertedCount, existingCount, duplicateInBatchCount }
    },
  }
}
