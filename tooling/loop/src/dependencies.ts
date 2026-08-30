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
 */

const HEADING = /^\s*(?:#{1,6}\s*)?depends\s+on\s*:?\s*(.*)$/i
const LIST_ITEM = /^\s*[-*]\s+(.*)$/
const ISSUE_REFERENCE = /#(\d+)\b/g

function collectReferences(text: string, into: Set<number>): void {
  for (const match of text.matchAll(ISSUE_REFERENCE)) {
    const value = Number(match[1])
    if (Number.isInteger(value) && value > 0) into.add(value)
  }
}

export interface DependencyDeclaration {
  /**
   * Whether the body has a `Depends on` block at all.
   *
   * Distinct from an empty list: `Depends on: none` is a statement that nothing
   * blocks the issue, and it overrides the fallback map. A body with no block
   * has simply not been asked the question.
   */
  declared: boolean
  dependencies: number[]
}

/** Parse the `Depends on` block, distinguishing "none" from "not stated". */
export function parseDependencyDeclaration(body: string | null | undefined): DependencyDeclaration {
  if (body === null || body === undefined) return { declared: false, dependencies: [] }

  const lines = body.split('\n')
  const dependencies = new Set<number>()
  let declared = false

  for (let index = 0; index < lines.length; index += 1) {
    const heading = HEADING.exec(lines[index] as string)
    if (heading === null) continue
    declared = true

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

  return { declared, dependencies: [...dependencies].sort((a, b) => a - b) }
}

/** Issue numbers the given issue body declares as dependencies. */
export function parseIssueDependencies(body: string | null | undefined): number[] {
  return parseDependencyDeclaration(body).dependencies
}
