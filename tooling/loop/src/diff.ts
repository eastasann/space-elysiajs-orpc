import { z } from 'zod'

export const DiffFileSchema = z.object({
  path: z.string(),
  status: z.enum(['added', 'modified', 'removed', 'renamed']),
  /** Text of lines this pull request adds, without the leading `+`. */
  addedLines: z.array(z.string()),
  /** Text of lines this pull request removes, without the leading `-`. */
  removedLines: z.array(z.string()),
})
export type DiffFile = z.infer<typeof DiffFileSchema>

export const PullRequestDiffSchema = z.object({
  files: z.array(DiffFileSchema),
})
export type PullRequestDiff = z.infer<typeof PullRequestDiffSchema>

export function additions(diff: PullRequestDiff): number {
  return diff.files.reduce((total, file) => total + file.addedLines.length, 0)
}

export function deletions(diff: PullRequestDiff): number {
  return diff.files.reduce((total, file) => total + file.removedLines.length, 0)
}

const FILE_HEADER = /^diff --git a\/(.+?) b\/(.+)$/
const RENAME_TO = /^rename to (.+)$/

/**
 * Parse a unified diff into the shape every downstream check consumes.
 *
 * Only what the policy needs is extracted: which files changed, how, and the
 * literal text of the lines added and removed. Hunk offsets are irrelevant to
 * every decision this package makes.
 */
export function parseUnifiedDiff(text: string): PullRequestDiff {
  const files: DiffFile[] = []
  let current: DiffFile | null = null

  for (const rawLine of text.split('\n')) {
    const header = FILE_HEADER.exec(rawLine)
    if (header !== null) {
      if (current !== null) files.push(current)
      current = {
        path: header[2] as string,
        status: 'modified',
        addedLines: [],
        removedLines: [],
      }
      continue
    }

    if (current === null) continue

    if (rawLine.startsWith('new file mode')) {
      current.status = 'added'
      continue
    }
    if (rawLine.startsWith('deleted file mode')) {
      current.status = 'removed'
      continue
    }
    const renamed = RENAME_TO.exec(rawLine)
    if (renamed !== null) {
      current.status = 'renamed'
      current.path = renamed[1] as string
      continue
    }

    // `+++`/`---` are headers, not content; `+`/`-` alone are content.
    if (rawLine.startsWith('+++') || rawLine.startsWith('---')) continue
    if (rawLine.startsWith('+')) current.addedLines.push(rawLine.slice(1))
    else if (rawLine.startsWith('-')) current.removedLines.push(rawLine.slice(1))
  }

  if (current !== null) files.push(current)
  return { files }
}
