/**
 * Primitives shared by risk classification and the deterministic review checks.
 *
 * Everything here reads only the diff. None of it consults a model, so the same
 * pull request always produces the same answer.
 */
import type { DiffFile } from './diff.ts'

/**
 * SQL that destroys data or drops structure.
 *
 * `DROP INDEX` is deliberately absent: it loses no data and is a routine part
 * of a generated migration.
 */
const DESTRUCTIVE_SQL = [
  /\bdrop\s+table\b/i,
  /\bdrop\s+schema\b/i,
  /\bdrop\s+database\b/i,
  /\btruncate\b/i,
  /\balter\s+table\b[\s\S]*?\bdrop\s+column\b/i,
  /\balter\s+table\b[\s\S]*?\bdrop\s+constraint\b/i,
]

export interface DestructiveStatement {
  line: string
  pattern: string
}

/** Destructive statements among the lines a migration adds. */
export function findDestructiveSql(addedLines: readonly string[]): DestructiveStatement[] {
  const found: DestructiveStatement[] = []
  for (const line of addedLines) {
    for (const pattern of DESTRUCTIVE_SQL) {
      if (pattern.test(line)) {
        found.push({ line: line.trim(), pattern: pattern.source })
        break
      }
    }
  }
  return found
}

const EXPORT_PATTERNS = [
  /^\s*export\s+(?:declare\s+)?(?:async\s+)?(?:const|let|var|function|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/,
  /^\s*export\s+default\s+(?:function\s+)?([A-Za-z_$][\w$]*)?/,
]

/**
 * Names a line exports.
 *
 * Handles both declaration exports and brace lists, including the one-name-per-
 * line style Biome formats long export lists into.
 */
export function extractExportedNames(lines: readonly string[]): Set<string> {
  const names = new Set<string>()

  for (const line of lines) {
    let matched = false
    for (const pattern of EXPORT_PATTERNS) {
      const match = pattern.exec(line)
      if (match?.[1] !== undefined) {
        names.add(match[1])
        matched = true
        break
      }
    }
    if (matched) continue

    // `export { a, b as c }` and the members of a multi-line export list.
    const braceList = /export\s*(?:type\s*)?\{([^}]*)\}/.exec(line)
    const body =
      braceList?.[1] ??
      (/^\s*(?:type\s+)?[A-Za-z_$][\w$]*\s*(?:as\s+[A-Za-z_$][\w$]*)?\s*,\s*$/.test(line)
        ? line
        : null)
    if (body === null) continue

    for (const entry of body.split(',')) {
      const name = /(?:type\s+)?([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?/.exec(
        entry.trim(),
      )
      const exported = name?.[2] ?? name?.[1]
      if (exported !== undefined && exported !== 'type') names.add(exported)
    }
  }

  return names
}

/**
 * Exported names this file removes and does not add back.
 *
 * Comparing sets rather than flagging any removed `export` line means a
 * reordering — which the formatter does routinely — is not mistaken for a
 * breaking change.
 */
export function removedExports(file: DiffFile): string[] {
  const removed = extractExportedNames(file.removedLines)
  const added = extractExportedNames(file.addedLines)
  return [...removed].filter((name) => !added.has(name)).sort()
}

export interface DependencyChange {
  name: string
  from: string | null
  to: string | null
  kind: 'added' | 'removed' | 'upgraded' | 'downgraded'
  /** True when the leading version number changes, e.g. `1.4.0` -> `2.0.0`. */
  major: boolean
}

const DEPENDENCY_LINE = /^\s*"([^"]+)"\s*:\s*"([^"]+)"\s*,?\s*$/

function leadingMajor(range: string): string | null {
  const match = /(\d+)\./.exec(range)
  return match?.[1] ?? null
}

/**
 * Dependency edits in a `package.json` diff.
 *
 * Read from the raw diff lines rather than by parsing both versions of the
 * file, because only one side of a change is available in a patch.
 */
/**
 * Values that are a dependency specifier rather than, say, a shell command.
 *
 * `DEPENDENCY_LINE` matches any `"key": "value"` pair, which in a package.json
 * diff also catches `scripts`. That reported `"docker:smoke": "docker compose
 * up …"` as a new dependency on a real pull request. A specifier is a semver
 * range or one of npm's protocols; a script is neither.
 */
const DEPENDENCY_VALUE =
  /^(?:workspace:|npm:|file:|link:|portal:|patch:|git\+|github:|https?:|[a-z-]+\/[a-z-]+#)|^[\^~>=<v ]*\d+(?:\.\d+)*(?:[-+.][\w.-]+)?$|^\*$|^latest$/i

export function dependencyChanges(file: DiffFile): DependencyChange[] {
  if (!file.path.endsWith('package.json')) return []

  const before = new Map<string, string>()
  const after = new Map<string, string>()

  for (const line of file.removedLines) {
    const match = DEPENDENCY_LINE.exec(line)
    if (match?.[1] !== undefined && match[2] !== undefined && DEPENDENCY_VALUE.test(match[2])) {
      before.set(match[1], match[2])
    }
  }
  for (const line of file.addedLines) {
    const match = DEPENDENCY_LINE.exec(line)
    if (match?.[1] !== undefined && match[2] !== undefined && DEPENDENCY_VALUE.test(match[2])) {
      after.set(match[1], match[2])
    }
  }

  const changes: DependencyChange[] = []
  for (const [name, to] of after) {
    const from = before.get(name) ?? null
    if (from === to) continue

    const fromMajor = from === null ? null : leadingMajor(from)
    const toMajor = leadingMajor(to)
    const major = fromMajor !== null && toMajor !== null && fromMajor !== toMajor

    changes.push({
      name,
      from,
      to,
      kind:
        from === null
          ? 'added'
          : major && Number(toMajor) < Number(fromMajor)
            ? 'downgraded'
            : from === null
              ? 'added'
              : 'upgraded',
      major,
    })
  }
  for (const [name, from] of before) {
    if (!after.has(name)) {
      changes.push({ name, from, to: null, kind: 'removed', major: false })
    }
  }

  return changes.sort((a, b) => a.name.localeCompare(b.name))
}
