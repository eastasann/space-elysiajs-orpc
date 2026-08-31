/**
 * Issue dependencies, expressed in the issue body.
 *
 * The convention is deliberately small — a heading or a line reading
 * `Depends on:` followed by issue references:
 *
 *     ## Depends on
 *
 *     - #12
 *     - #13
 *
 * or, on one line:
 *
 *     Depends on: #12, #13
 *
 * `Depends on: none` states explicitly that there are none, which is worth
 * writing: it distinguishes "checked, nothing blocks this" from "nobody filled
 * the section in".
 *
 * References are only read from inside that block. A `#12` mentioned anywhere
 * else in the body is prose, not a dependency, and treating it as one would
 * quietly stall issues.
 *
 * A block that names no `#N` reference and does not say `none` — prose such as
 * `Depends on **[M1.03] ...**` — has not actually answered the question. It is
 * treated the same as no block at all, so callers fall through to whatever
 * fallback they have, rather than silently reading it as "nothing blocks
 * this": the one meaning `Depends on: none` is reserved for.
 */

const HEADING = /^\s*(?:#{1,6}\s*)?depends\s+on\s*:?\s*(.*)$/i
const LIST_ITEM = /^\s*[-*]\s+(.*)$/
const ISSUE_REFERENCE = /#(\d+)\b/g
const NONE = /^none\.?$/i

function collectReferences(text: string, into: Set<number>): void {
  for (const match of text.matchAll(ISSUE_REFERENCE)) {
    const value = Number(match[1])
    if (Number.isInteger(value) && value > 0) into.add(value)
  }
}

export interface DependencyDeclaration {
  /**
   * Whether the body answers the dependency question.
   *
   * True when a `Depends on` block names at least one `#N` reference, or says
   * `none` explicitly. A body with no block, or a block whose text names
   * nothing parsable, has not been asked-and-answered — it reads the same as
   * absent, so a caller with a fallback (`fallbackDependencies`) uses it.
   */
  declared: boolean
  dependencies: number[]
}

/** Parse the `Depends on` block, distinguishing "none" from "not stated". */
export function parseDependencyDeclaration(body: string | null | undefined): DependencyDeclaration {
  if (body === null || body === undefined) return { declared: false, dependencies: [] }

  const lines = body.split('\n')
  const dependencies = new Set<number>()
  let blockFound = false
  let explicitNone = false

  for (let index = 0; index < lines.length; index += 1) {
    const heading = HEADING.exec(lines[index] as string)
    if (heading === null) continue
    blockFound = true

    const headingText = (heading[1] ?? '').trim()
    if (NONE.test(headingText)) explicitNone = true

    collectReferences(heading[1] ?? '', dependencies)

    // Consume the list that follows, tolerating blank lines between the heading
    // and the first item.
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const line = lines[cursor] as string
      if (line.trim().length === 0) {
        // A blank line ends the block once items have started.
        if (dependencies.size > 0 && LIST_ITEM.test(lines[cursor - 1] as string)) break
        continue
      }

      const item = LIST_ITEM.exec(line)
      if (item === null) break
      collectReferences(item[1] as string, dependencies)
    }
  }

  const declared = blockFound && (dependencies.size > 0 || explicitNone)

  return { declared, dependencies: [...dependencies].sort((a, b) => a - b) }
}

/** Issue numbers the given issue body declares as dependencies. */
export function parseIssueDependencies(body: string | null | undefined): number[] {
  return parseDependencyDeclaration(body).dependencies
}
