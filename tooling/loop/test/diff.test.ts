import { describe, expect, it } from 'bun:test'
import { additions, deletions, parseUnifiedDiff } from '../src/diff.ts'

const SAMPLE = `diff --git a/apps/api/src/server.ts b/apps/api/src/server.ts
index 1111111..2222222 100644
--- a/apps/api/src/server.ts
+++ b/apps/api/src/server.ts
@@ -1,3 +1,3 @@
-const a = 1
+const a = 2
+const b = 3
diff --git a/packages/db/drizzle/0001_x.sql b/packages/db/drizzle/0001_x.sql
new file mode 100644
--- /dev/null
+++ b/packages/db/drizzle/0001_x.sql
@@ -0,0 +1,1 @@
+DROP TABLE "articles";
diff --git a/old.ts b/old.ts
deleted file mode 100644
--- a/old.ts
+++ /dev/null
@@ -1,1 +0,0 @@
-export const gone = true
`

describe('parseUnifiedDiff', () => {
  it('separates files and their added and removed lines', () => {
    const diff = parseUnifiedDiff(SAMPLE)

    expect(diff.files.map((file) => file.path)).toEqual([
      'apps/api/src/server.ts',
      'packages/db/drizzle/0001_x.sql',
      'old.ts',
    ])
    expect(diff.files[0]?.addedLines).toEqual(['const a = 2', 'const b = 3'])
    expect(diff.files[0]?.removedLines).toEqual(['const a = 1'])
  })

  it('records file status', () => {
    const diff = parseUnifiedDiff(SAMPLE)

    expect(diff.files.map((file) => file.status)).toEqual(['modified', 'added', 'removed'])
  })

  it('does not mistake the +++ and --- headers for content', () => {
    const diff = parseUnifiedDiff(SAMPLE)

    expect(diff.files[1]?.addedLines).toEqual(['DROP TABLE "articles";'])
    expect(diff.files[1]?.removedLines).toEqual([])
  })

  it('counts additions and deletions', () => {
    const diff = parseUnifiedDiff(SAMPLE)

    expect(additions(diff)).toBe(3)
    expect(deletions(diff)).toBe(2)
  })

  it('handles an empty diff', () => {
    expect(parseUnifiedDiff('').files).toEqual([])
  })

  it('records a rename under its new path', () => {
    const renamed = parseUnifiedDiff(
      'diff --git a/a.ts b/b.ts\nsimilarity index 100%\nrename from a.ts\nrename to b.ts\n',
    )

    expect(renamed.files[0]).toMatchObject({ path: 'b.ts', status: 'renamed' })
  })
})
