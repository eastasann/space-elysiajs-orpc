/**
 * Minimal path matcher for the loop policy.
 *
 * Deliberately hand-written rather than pulled from a dependency: the merge
 * policy decides what may merge without a human, so the code that interprets it
 * should be short enough to audit in one sitting.
 *
 * Supported syntax:
 *   `**`  matches zero or more whole path segments
 *   `*`   matches zero or more characters within one segment
 *   `?`   matches exactly one character within one segment
 */

function segmentToRegExp(segment: string): RegExp {
  let source = '^'
  for (const character of segment) {
    if (character === '*') source += '[^/]*'
    else if (character === '?') source += '[^/]'
    else source += character.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`${source}$`)
}

function matchSegments(pattern: readonly string[], path: readonly string[]): boolean {
  if (pattern.length === 0) return path.length === 0

  const [head, ...rest] = pattern
  if (head === '**') {
    // Zero segments, then one segment at a time.
    for (let consumed = 0; consumed <= path.length; consumed += 1) {
      if (matchSegments(rest, path.slice(consumed))) return true
    }
    return false
  }

  if (path.length === 0) return false
  if (head === undefined) return false
  if (!segmentToRegExp(head).test(path[0] as string)) return false

  return matchSegments(rest, path.slice(1))
}

/** Does `path` match `pattern`? Paths are repository-relative and use `/`. */
export function matchesGlob(pattern: string, path: string): boolean {
  const normalisedPath = path
    .replace(/^\.\//, '')
    .split('/')
    .filter((s) => s.length > 0)
  const normalisedPattern = pattern
    .replace(/^\.\//, '')
    .split('/')
    .filter((s) => s.length > 0)
  return matchSegments(normalisedPattern, normalisedPath)
}

/** Does `path` match any of `patterns`? */
export function matchesAnyGlob(patterns: readonly string[], path: string): boolean {
  return patterns.some((pattern) => matchesGlob(pattern, path))
}
