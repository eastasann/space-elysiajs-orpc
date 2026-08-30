/**
 * Choose the next issue for the coding agent.
 *
 * Reads:
 *   LOOP_ISSUES       path to a JSON array of issues (number, title, state, labels, body)
 *   LOOP_DEPENDENCIES path to the fallback dependency map (optional)
 *   LOOP_OUTPUT_DIR   directory to write selection.json and summary.md into
 *
 * Selection is advisory. The workflow still has to claim the issue by applying
 * `agent:in-progress` and re-reading it, because GitHub has no
 * compare-and-set on labels — see docs/loop-engineering.md.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_SELECTION_POLICY, selectNextIssue } from '../src/eligibility.ts'
import { renderSelectionSummary } from '../src/summary.ts'
import { FallbackDependenciesSchema, IssueListSchema } from './context.ts'

const issuesPath = process.env.LOOP_ISSUES
if (issuesPath === undefined || issuesPath.trim() === '') {
  process.stderr.write('LOOP_ISSUES is required\n')
  process.exit(1)
}

const issues = IssueListSchema.parse(JSON.parse(readFileSync(issuesPath, 'utf8')))

const fallbackPath = process.env.LOOP_DEPENDENCIES ?? '.github/loop-dependencies.json'
const fallbackDependencies = existsSync(fallbackPath)
  ? FallbackDependenciesSchema.parse(JSON.parse(readFileSync(fallbackPath, 'utf8'))).dependencies
  : {}

const result = selectNextIssue(issues, { ...DEFAULT_SELECTION_POLICY, fallbackDependencies })

const outputDir = process.env.LOOP_OUTPUT_DIR ?? '.loop'
mkdirSync(outputDir, { recursive: true })

writeFileSync(join(outputDir, 'selection.json'), `${JSON.stringify(result, null, 2)}\n`)
writeFileSync(
  join(outputDir, 'summary.md'),
  `${renderSelectionSummary(result.candidates, result.selected?.number ?? null, result.stopReason)}\n`,
)

const githubOutput = process.env.GITHUB_OUTPUT
if (githubOutput !== undefined) {
  appendFileSync(
    githubOutput,
    [
      `selected=${result.selected?.number ?? ''}`,
      `has_selection=${result.selected !== null}`,
      `stop_reason=${(result.stopReason ?? '').replace(/[\r\n]+/g, ' ')}`,
      '',
    ].join('\n'),
  )
}

process.stdout.write(
  result.selected === null
    ? `no issue selected: ${result.stopReason}\n`
    : `selected #${result.selected.number}\n`,
)
